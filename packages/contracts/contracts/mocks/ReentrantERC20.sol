// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only ERC-20 that re-enters an armed target once during
///         `transferFrom`, recording whether the reentrant call succeeded.
///         Used to prove ArticleActions' `nonReentrant` guard fires.
contract ReentrantERC20 is ERC20 {
    address public target;
    bytes public data;
    bool public reenteredOnce;
    bool public reentrySucceeded;
    bool private _in;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address t, bytes calldata d) external {
        target = t;
        data = d;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (target != address(0) && !_in && !reenteredOnce) {
            _in = true;
            reenteredOnce = true;
            (bool ok, ) = target.call(data);
            reentrySucceeded = ok;
            _in = false;
        }
        return super.transferFrom(from, to, value);
    }
}
