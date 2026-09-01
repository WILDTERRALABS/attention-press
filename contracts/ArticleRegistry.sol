// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IArticleRegistry} from "./interfaces/IArticleRegistry.sol";

/// @title ArticleRegistry
/// @notice On-chain index of published articles. Only a content hash and pointer
///         live on-chain; the article body itself belongs on IPFS/Arweave.
/// @dev    Authorship is mutable only by the current author (transfer / retire).
contract ArticleRegistry is IArticleRegistry {
    struct Article {
        address author; // payout recipient; address(0) == does not exist
        bytes32 contentHash; // digest of the canonical, immutable article body
        uint64 createdAt;
        bool retired; // author disabled new reading sessions
    }

    /// @notice Id of the next article to be minted. Ids start at 1.
    uint256 public nextId = 1;

    mapping(uint256 => Article) public articles;
    /// @notice Off-chain pointer (e.g. ipfs://CID) with title, author name, cover, etc.
    mapping(uint256 => string) public metadataURI;

    event Published(uint256 indexed id, address indexed author, bytes32 contentHash, string metadataURI);
    event MetadataUpdated(uint256 indexed id, string metadataURI);
    event Retired(uint256 indexed id);
    event AuthorshipTransferred(uint256 indexed id, address indexed from, address indexed to);

    error NotAuthor();
    error UnknownArticle();
    error EmptyContentHash();
    error ZeroAddress();

    modifier onlyAuthor(uint256 id) {
        address a = articles[id].author;
        if (a == address(0)) revert UnknownArticle();
        if (a != msg.sender) revert NotAuthor();
        _;
    }

    /// @notice Register a new article. Anyone may publish.
    /// @param contentHash digest binding this id to an exact article body.
    /// @param uri off-chain metadata pointer (may be updated later).
    function publish(bytes32 contentHash, string calldata uri) external returns (uint256 id) {
        if (contentHash == bytes32(0)) revert EmptyContentHash();
        id = nextId++;
        articles[id] =
            Article({author: msg.sender, contentHash: contentHash, createdAt: uint64(block.timestamp), retired: false});
        metadataURI[id] = uri;
        emit Published(id, msg.sender, contentHash, uri);
    }

    function updateMetadata(uint256 id, string calldata uri) external onlyAuthor(id) {
        metadataURI[id] = uri;
        emit MetadataUpdated(id, uri);
    }

    /// @notice Stop new reading sessions for an article. Existing sessions are unaffected.
    function retire(uint256 id) external onlyAuthor(id) {
        articles[id].retired = true;
        emit Retired(id);
    }

    /// @notice Hand payout rights to another address (e.g. a multisig or splitter).
    function transferAuthorship(uint256 id, address to) external onlyAuthor(id) {
        if (to == address(0)) revert ZeroAddress();
        articles[id].author = to;
        emit AuthorshipTransferred(id, msg.sender, to);
    }

    /// @inheritdoc IArticleRegistry
    function authorOf(uint256 id) external view returns (address) {
        address a = articles[id].author;
        if (a == address(0)) revert UnknownArticle();
        return a;
    }

    /// @inheritdoc IArticleRegistry
    function isActive(uint256 id) external view returns (bool) {
        Article storage a = articles[id];
        return a.author != address(0) && !a.retired;
    }
}
