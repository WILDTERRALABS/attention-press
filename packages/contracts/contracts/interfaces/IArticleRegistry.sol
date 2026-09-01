// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IArticleRegistry
/// @notice Minimal surface the AttentionStream contract needs from the registry.
interface IArticleRegistry {
    /// @notice Current author (payout recipient) for an article.
    /// @dev MUST revert for unknown ids so callers cannot open sessions against them.
    function authorOf(uint256 id) external view returns (address);

    /// @notice True if the article exists and has not been retired by its author.
    function isActive(uint256 id) external view returns (bool);
}
