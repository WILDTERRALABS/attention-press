// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IArticleRegistry} from "./interfaces/IArticleRegistry.sol";

/// @title AttentionStream
/// @notice Reader-funded, pay-per-second reading. Each reading session is a
///         unidirectional payment channel: the reader escrows a capped budget,
///         then a browser-held session key signs monotonically increasing
///         `cumulativeAmount` vouchers while the reader is actually on the page.
///         The author redeems the latest voucher on-chain; the reader is refunded
///         whatever budget was not streamed.
///
/// @dev    Closing is two-phase, so a reader cannot end the session and walk away
///         before the author's collector settles the last voucher:
///           1. `closeSession(id)` records an accrual cutoff (`closeInitiatedAt`)
///              and does NOT refund. Accrual is frozen at that timestamp.
///           2. For `challengeWindow` seconds anyone may still `settle` vouchers
///              the session key signed at or before the cutoff.
///           3. `finalizeSession(id)` (permissionless) then refunds
///              `budget - claimed` to the reader and closes the channel.
///         A collector-less reader recovers funds unilaterally:
///         `closeSession` -> wait `challengeWindow` -> `finalizeSession`. An
///         abandoned session can be force-closed by anyone once
///         `MAX_ACCRUAL_WINDOW` has elapsed.
///
/// @dev    Trust model
///         - No proof-of-personhood / anti-sybil machinery. Because the reader
///           funds the stream and value flows reader -> author, a publisher who
///           "reads" their own article via bots only loses the protocol fee and
///           gas. Fake attention is strictly unprofitable.
///         - The reader trusts their own client to stop signing vouchers when the
///           tab loses focus. This is bounded on-chain by `budget` (hard cap) and
///           `ratePerSec` (accrual cap). Keep default budgets small and session
///           lengths short in the UI.
contract AttentionStream is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev EIP-712 typehash for a payment voucher.
    bytes32 private constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 sessionId,uint256 cumulativeAmount)");

    uint16 public constant MAX_FEE_BPS = 1_000; // 10%
    uint64 public constant MIN_CHALLENGE_WINDOW = 1 minutes;
    uint64 public constant MAX_CHALLENGE_WINDOW = 1 days;
    /// @dev Upper bound on how far `ratePerSec` accrual is allowed to run, so a
    ///      never-closed session cannot be drained at full rate indefinitely.
    ///      Also the point after which anyone may force-close an abandoned session.
    uint64 public constant MAX_ACCRUAL_WINDOW = 7 days;

    IERC20 public immutable token;
    IArticleRegistry public immutable registry;

    address public treasury;
    uint16 public protocolFeeBps;
    /// @notice Seconds after `closeSession` during which vouchers may still settle
    ///         before `finalizeSession` refunds the reader.
    uint64 public challengeWindow = 15 minutes;

    struct Session {
        address reader; // escrow owner + refund recipient
        address signer; // ephemeral browser key authorized to sign vouchers
        address author; // payout recipient, cached at open time
        uint96 budget; // total escrowed; hard cap on cumulativeAmount
        uint96 claimed; // amount already streamed to the author
        uint64 articleId;
        uint64 startTime;
        uint64 ratePerSec; // max streaming rate; caps voucher accrual
        bool open;
    }

    mapping(bytes32 => Session) public sessions;
    /// @notice 0 while live; the timestamp `closeSession` was called otherwise.
    ///         Freezes accrual at that instant and starts the challenge window.
    mapping(bytes32 => uint64) public closeInitiatedAt;
    /// @notice Per-reader counter feeding session id derivation.
    mapping(address => uint256) public openCount;

    // --- Discovery stats (informational; a self-funded reader can inflate these,
    //     so rank on `articleEarned` / distinct payers off-chain, not raw counts) ---
    mapping(uint256 => uint256) public articleEarned; // gross streamed to author, pre-fee
    mapping(uint256 => uint256) public articleReaderSeconds; // sum of closed-session durations
    mapping(uint256 => uint32) public articleSessions;

    event SessionOpened(
        bytes32 indexed id,
        uint256 indexed articleId,
        address indexed reader,
        address author,
        address signer,
        uint96 budget,
        uint64 ratePerSec
    );
    event Settled(bytes32 indexed id, uint256 indexed articleId, uint96 cumulativeAmount, uint96 delta, uint96 fee);
    /// @notice Phase 1: accrual frozen at `initiatedAt`, challenge window running.
    event SessionClosing(bytes32 indexed id, uint256 indexed articleId, uint64 initiatedAt);
    /// @notice Phase 2: reader refunded, channel closed.
    event SessionClosed(
        bytes32 indexed id, uint256 indexed articleId, uint96 totalPaid, uint96 refunded, uint64 duration
    );
    event TreasuryUpdated(address treasury);
    event ProtocolFeeUpdated(uint16 bps);
    event ChallengeWindowUpdated(uint64 window);

    error ArticleInactive();
    error BadParams();
    error NotReader();
    error SessionNotOpen();
    error AlreadyClosing();
    error NotClosing();
    error ChallengeWindowOpen();
    error ChallengeWindowClosed();
    error NonMonotonic();
    error OverBudget();
    error RateExceeded();
    error BadSignature();

    constructor(IERC20 _token, IArticleRegistry _registry, address _treasury, uint16 _feeBps)
        EIP712("AttentionStream", "1")
        Ownable(msg.sender)
    {
        if (address(_token) == address(0) || address(_registry) == address(0) || _treasury == address(0)) {
            revert BadParams();
        }
        if (_feeBps > MAX_FEE_BPS) revert BadParams();
        token = _token;
        registry = _registry;
        treasury = _treasury;
        protocolFeeBps = _feeBps;
    }

    // ---------------------------------------------------------------------------
    // Reader / author flow
    // ---------------------------------------------------------------------------

    /// @notice Open a reading session and escrow `budget` of the payment token.
    /// @param articleId  target article; must be active in the registry.
    /// @param budget     hard cap the reader can spend this session.
    /// @param ratePerSec advertised streaming rate; also the on-chain accrual cap.
    /// @param signer     ephemeral key (generated in the reader's browser) that
    ///                   will sign vouchers. Compromise is bounded by budget+rate.
    function openSession(uint64 articleId, uint96 budget, uint64 ratePerSec, address signer)
        external
        nonReentrant
        returns (bytes32 id)
    {
        if (!registry.isActive(articleId)) revert ArticleInactive();
        if (budget == 0 || ratePerSec == 0 || signer == address(0)) revert BadParams();

        address author = registry.authorOf(articleId);

        id = keccak256(abi.encode(msg.sender, openCount[msg.sender]++, block.chainid, articleId, address(this)));
        if (sessions[id].reader != address(0)) revert BadParams(); // unreachable in practice

        sessions[id] = Session({
            reader: msg.sender,
            signer: signer,
            author: author,
            budget: budget,
            claimed: 0,
            articleId: articleId,
            startTime: uint64(block.timestamp),
            ratePerSec: ratePerSec,
            open: true
        });

        unchecked {
            articleSessions[articleId] += 1;
        }

        token.safeTransferFrom(msg.sender, address(this), budget);
        emit SessionOpened(id, articleId, msg.sender, author, signer, budget, ratePerSec);
    }

    /// @notice Ratchet the amount streamed to the author up to `cumulativeAmount`.
    /// @dev Permissionless: normally called by the author's collector service.
    ///      Works while the session is live and, once closing, until
    ///      `closeInitiatedAt + challengeWindow`. Accrual is capped at the close
    ///      timestamp during the window, so no post-close voucher can help the
    ///      reader.
    function settle(bytes32 id, uint96 cumulativeAmount, bytes calldata sig) external nonReentrant {
        Session storage s = sessions[id];
        if (!s.open) revert SessionNotOpen();

        uint64 cAt = closeInitiatedAt[id];
        if (cAt != 0 && block.timestamp > uint256(cAt) + challengeWindow) revert ChallengeWindowClosed();

        _verify(id, s.signer, cumulativeAmount, sig);
        _applySettlement(id, s, cumulativeAmount, cAt != 0 ? cAt : block.timestamp);
    }

    /// @notice Phase 1 of closing: freeze accrual and start the challenge window.
    ///         Does NOT refund. Callable by the reader any time, or by anyone once
    ///         `MAX_ACCRUAL_WINDOW` has elapsed (abandoned-session recovery).
    function closeSession(bytes32 id) external nonReentrant {
        Session storage s = sessions[id];
        if (!s.open) revert SessionNotOpen();
        if (closeInitiatedAt[id] != 0) revert AlreadyClosing();

        bool abandoned = block.timestamp >= uint256(s.startTime) + MAX_ACCRUAL_WINDOW;
        if (msg.sender != s.reader && !abandoned) revert NotReader();

        closeInitiatedAt[id] = uint64(block.timestamp);
        emit SessionClosing(id, s.articleId, uint64(block.timestamp));
    }

    /// @notice Phase 2: after the challenge window, refund `budget - claimed` to
    ///         the reader and close the channel. Permissionless.
    function finalizeSession(bytes32 id) external nonReentrant {
        Session storage s = sessions[id];
        if (!s.open) revert SessionNotOpen();

        uint64 cAt = closeInitiatedAt[id];
        if (cAt == 0) revert NotClosing();
        if (block.timestamp <= uint256(cAt) + challengeWindow) revert ChallengeWindowOpen();

        s.open = false; // effects before interactions

        uint96 refund = s.budget - s.claimed;
        uint64 duration = cAt - s.startTime;

        unchecked {
            articleReaderSeconds[s.articleId] += duration;
        }

        if (refund > 0) token.safeTransfer(s.reader, refund);
        emit SessionClosed(id, s.articleId, s.claimed, refund, duration);
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    function _verify(bytes32 id, address signer, uint256 cumulativeAmount, bytes calldata sig) internal view {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, id, cumulativeAmount)));
        if (ECDSA.recover(digest, sig) != signer) revert BadSignature();
    }

    /// @dev Largest `cumulativeAmount` the rate cap permits, measured to
    ///      `referenceTs` (wall clock while live, the close timestamp once closing).
    function _maxAccrued(Session storage s, uint256 referenceTs) internal view returns (uint256) {
        uint256 endCap = uint256(s.startTime) + MAX_ACCRUAL_WINDOW;
        uint256 nowTs = referenceTs < endCap ? referenceTs : endCap;
        uint256 elapsed = nowTs - s.startTime;
        // +1s slack absorbs clock skew between the signer and the chain.
        return uint256(s.ratePerSec) * (elapsed + 1);
    }

    function _applySettlement(bytes32 id, Session storage s, uint96 cumulativeAmount, uint256 referenceTs) internal {
        if (cumulativeAmount < s.claimed) revert NonMonotonic();
        if (cumulativeAmount > s.budget) revert OverBudget();
        if (cumulativeAmount > _maxAccrued(s, referenceTs)) revert RateExceeded();

        uint96 delta = cumulativeAmount - s.claimed;
        s.claimed = cumulativeAmount; // effects before interactions

        uint96 fee = uint96((uint256(delta) * protocolFeeBps) / 10_000);
        unchecked {
            articleEarned[s.articleId] += delta;
        }

        if (delta > 0) {
            if (fee > 0) token.safeTransfer(treasury, fee);
            token.safeTransfer(s.author, delta - fee);
        }
        emit Settled(id, s.articleId, cumulativeAmount, delta, fee);
    }

    // ---------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert BadParams();
        treasury = t;
        emit TreasuryUpdated(t);
    }

    function setProtocolFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadParams();
        protocolFeeBps = bps;
        emit ProtocolFeeUpdated(bps);
    }

    function setChallengeWindow(uint64 w) external onlyOwner {
        if (w < MIN_CHALLENGE_WINDOW || w > MAX_CHALLENGE_WINDOW) revert BadParams();
        challengeWindow = w;
        emit ChallengeWindowUpdated(w);
    }

    // ---------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------

    /// @notice EIP-712 domain separator, exposed for client-side voucher signing.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Amount currently claimable by the author for `id` given a voucher value.
    function claimableFor(bytes32 id, uint96 cumulativeAmount) external view returns (uint96) {
        Session storage s = sessions[id];
        if (!s.open || cumulativeAmount <= s.claimed) return 0;

        uint64 cAt = closeInitiatedAt[id];
        if (cAt != 0 && block.timestamp > uint256(cAt) + challengeWindow) return 0;

        uint256 capped = cumulativeAmount;
        if (capped > s.budget) capped = s.budget;
        uint256 rateCap = _maxAccrued(s, cAt != 0 ? cAt : block.timestamp);
        if (capped > rateCap) capped = rateCap;
        if (capped <= s.claimed) return 0;
        return uint96(capped - s.claimed);
    }
}
