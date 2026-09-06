// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IArticleRegistry} from "./interfaces/IArticleRegistry.sol";

/// @title ArticleActions
/// @notice Discrete paid engagement on published articles, denominated in the
///         same ERC-20 as AttentionStream (WMON on Monad):
///           - like / favorite  : 1 WMON  -> author (minus `actionFeeBps` to treasury)
///           - reply             : 2 WMON  -> author (minus fee), text in the event
///           - dislike           : 1 WMON  -> treasury only (author does not profit
///                                   from a negative signal)
///           - tip               : reader-chosen amount -> author (minus fee)
///
/// @dev    This contract is intentionally standalone. It only *reads*
///         `IArticleRegistry` (`isActive`, `authorOf`) and never calls or is
///         called by AttentionStream, so deploying it cannot affect sessions or
///         the streaming payment flow.
///
///         Safety:
///         - Never custodies the token: every payment is a direct
///           `transferFrom(payer -> recipient)`.
///         - Every token-moving function is `nonReentrant`, `whenNotPaused`, and
///           checks-effects-interactions (state written before any transfer).
///         - `msg.sender != authorOf(id)` on all actions (authors cannot pay
///           themselves). Sock-puppet inflation of like/favorite counts still
///           costs `actionFeeBps` per fake action.
///         - Fee-on-transfer / rebasing tokens are NOT supported (the delivered
///           amount is not verified); `token` is immutable and set to WMON.
///         - `pause()` is owner-only centralization; on mainnet `owner` MUST be a
///           timelocked multisig (see SECURITY.md).
contract ArticleActions is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant LIKE_PRICE = 1e18;
    uint256 public constant DISLIKE_PRICE = 1e18;
    uint256 public constant FAVORITE_PRICE = 1e18;
    uint256 public constant REPLY_PRICE = 2e18;

    uint16 public constant MAX_FEE_BPS = 1_000; // 10%
    uint256 public constant MAX_REPLY_BYTES = 1_000;
    /// @notice Hard ceiling on replies per article — bounds worst-case event-log
    ///         / indexer griefing by a well-funded spammer. Far above any
    ///         realistic legitimate thread.
    uint256 public constant MAX_REPLIES_PER_ARTICLE = 100_000;

    IERC20 public immutable token;
    IArticleRegistry public immutable registry;
    /// @notice Immutable: set once at deploy, no setter. Removes the owner's
    ///         ability to redirect the fee / dislike flow. Change it => redeploy.
    address public immutable treasury;

    /// @notice Skimmed to the treasury on like / favorite / reply / tip. Not applied
    ///         to dislike (which is 100% treasury already).
    uint16 public actionFeeBps;

    mapping(uint256 articleId => mapping(address actor => bool)) public hasLiked;
    mapping(uint256 articleId => mapping(address actor => bool)) public hasDisliked;
    mapping(uint256 articleId => mapping(address actor => bool)) public hasFavorited;

    mapping(uint256 articleId => uint256) public likeCount;
    mapping(uint256 articleId => uint256) public dislikeCount;
    mapping(uint256 articleId => uint256) public favoriteCount;
    mapping(uint256 articleId => uint256) public replyCount;
    mapping(uint256 articleId => uint256) public totalTipped;

    struct Reply {
        address actor;
        uint64 blockTime;
    }

    mapping(uint256 articleId => mapping(uint256 index => Reply)) private _replies;

    event Liked(uint256 indexed articleId, address indexed actor, uint256 toAuthor, uint256 fee);
    event Disliked(uint256 indexed articleId, address indexed actor, uint256 toTreasury);
    event Favorited(uint256 indexed articleId, address indexed actor, uint256 toAuthor, uint256 fee);
    event Replied(
        uint256 indexed articleId,
        address indexed actor,
        uint256 indexed index,
        uint256 toAuthor,
        uint256 fee,
        string text
    );
    event Tipped(uint256 indexed articleId, address indexed actor, uint256 toAuthor, uint256 fee);
    event ActionFeeUpdated(uint16 bps);

    error ArticleInactive();
    error SelfAction();
    error AlreadyLiked();
    error AlreadyDisliked();
    error AlreadyFavorited();
    error BadParams();
    error UnknownReply();
    error ReplyLimitReached();
    /// @dev Payment recipient may not be this contract — it has no withdrawal
    ///      path, so funds sent here (e.g. via `transferAuthorship` to this
    ///      address) would be permanently locked.
    error InvalidRecipient();

    constructor(IERC20 _token, IArticleRegistry _registry, address _treasury, uint16 _feeBps) Ownable(msg.sender) {
        if (address(_token) == address(0) || address(_registry) == address(0) || _treasury == address(0)) {
            revert BadParams();
        }
        if (_feeBps > MAX_FEE_BPS) revert BadParams();
        token = _token;
        registry = _registry;
        treasury = _treasury;
        actionFeeBps = _feeBps;
    }

    // ---------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------

    function like(uint256 articleId) external whenNotPaused nonReentrant {
        address author = _actionableAuthor(articleId);
        if (hasLiked[articleId][msg.sender]) revert AlreadyLiked();

        hasLiked[articleId][msg.sender] = true;
        unchecked {
            ++likeCount[articleId];
        }

        uint256 fee = _payAuthor(author, LIKE_PRICE);
        emit Liked(articleId, msg.sender, LIKE_PRICE - fee, fee);
    }

    function favorite(uint256 articleId) external whenNotPaused nonReentrant {
        address author = _actionableAuthor(articleId);
        if (hasFavorited[articleId][msg.sender]) revert AlreadyFavorited();

        hasFavorited[articleId][msg.sender] = true;
        unchecked {
            ++favoriteCount[articleId];
        }

        uint256 fee = _payAuthor(author, FAVORITE_PRICE);
        emit Favorited(articleId, msg.sender, FAVORITE_PRICE - fee, fee);
    }

    /// @notice Dislike pays the treasury only — the author must not earn from a
    ///         negative signal — while still costing the caller (anti-spam).
    function dislike(uint256 articleId) external whenNotPaused nonReentrant {
        _actionableAuthor(articleId); // enforces isActive + not-self
        if (hasDisliked[articleId][msg.sender]) revert AlreadyDisliked();

        hasDisliked[articleId][msg.sender] = true;
        unchecked {
            ++dislikeCount[articleId];
        }

        token.safeTransferFrom(msg.sender, treasury, DISLIKE_PRICE);
        emit Disliked(articleId, msg.sender, DISLIKE_PRICE);
    }

    /// @notice Post a paid reply. `text` is emitted in the event, not stored in
    ///         contract state; only `{actor, blockTime}` is kept on-chain.
    function reply(uint256 articleId, string calldata text) external whenNotPaused nonReentrant {
        address author = _actionableAuthor(articleId);
        uint256 len = bytes(text).length;
        if (len == 0 || len > MAX_REPLY_BYTES) revert BadParams();

        uint256 index = replyCount[articleId];
        if (index >= MAX_REPLIES_PER_ARTICLE) revert ReplyLimitReached();
        _replies[articleId][index] = Reply({actor: msg.sender, blockTime: uint64(block.timestamp)});
        unchecked {
            ++replyCount[articleId];
        }

        uint256 fee = _payAuthor(author, REPLY_PRICE);
        emit Replied(articleId, msg.sender, index, REPLY_PRICE - fee, fee, text);
    }

    /// @notice Reader-chosen tip straight to the author (minus fee).
    function tip(uint256 articleId, uint256 amount) external whenNotPaused nonReentrant {
        address author = _actionableAuthor(articleId);
        if (amount == 0) revert BadParams();

        totalTipped[articleId] += amount;

        uint256 fee = _payAuthor(author, amount);
        emit Tipped(articleId, msg.sender, amount - fee, fee);
    }

    // ---------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------

    function setActionFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert BadParams();
        actionFeeBps = bps;
        emit ActionFeeUpdated(bps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------

    function replyAt(uint256 articleId, uint256 index) external view returns (address actor, uint64 blockTime) {
        if (index >= replyCount[articleId]) revert UnknownReply();
        Reply storage r = _replies[articleId][index];
        return (r.actor, r.blockTime);
    }

    // ---------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------

    /// @dev Reverts unless the article is active, the caller is not its author,
    ///      and the author is not this contract (a `transferAuthorship` to this
    ///      address would otherwise let actions lock funds here forever).
    function _actionableAuthor(uint256 articleId) internal view returns (address author) {
        if (!registry.isActive(articleId)) revert ArticleInactive();
        author = registry.authorOf(articleId);
        if (author == address(this)) revert InvalidRecipient();
        if (msg.sender == author) revert SelfAction();
    }

    /// @dev Pulls `price` from the caller: `price - fee` to the author, `fee` to
    ///      the treasury. Interactions only — call after all state writes.
    function _payAuthor(address author, uint256 price) internal returns (uint256 fee) {
        if (author == address(this)) revert InvalidRecipient(); // defence in depth
        fee = (price * actionFeeBps) / 10_000;
        token.safeTransferFrom(msg.sender, author, price - fee);
        if (fee > 0) token.safeTransferFrom(msg.sender, treasury, fee);
    }
}
