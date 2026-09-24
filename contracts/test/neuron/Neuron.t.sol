// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PairPadFeeEscrow} from "../../src/v2/PairPadFeeEscrow.sol";
import {PairPadLaunchFactory} from "../../src/v2/PairPadLaunchFactory.sol";
import {PairPadLauncherToken} from "../../src/v2/PairPadLauncherToken.sol";
import {IPairPadFeeEscrow} from "../../src/v2/interfaces/ILaunchpadV2.sol";
import {NeuronParentRegistry} from "../../src/neuron/NeuronParentRegistry.sol";
import {NeuronParentSplitter, INeuronSwapRouter, INeuronParentRegistry} from "../../src/neuron/NeuronParentSplitter.sol";
import {NeuronLauncher, INeuronLaunchFactory, INeuronRegistryListing} from "../../src/neuron/NeuronLauncher.sol";

contract BurnableToken is ERC20, ERC20Burnable {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stands in for PairPadRouter.swapExactIn on an ETH -> token pool:
/// mints `rate` tokens per wei of ETH to the recipient.
contract MockRouter is INeuronSwapRouter {
    uint256 public rate = 1000;
    uint256 public calls;

    function setRate(uint256 r) external {
        rate = r;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        payable
        returns (uint256 amountOut)
    {
        require(zeroForOne, "direction");
        require(Currency.unwrap(key.currency0) == address(0), "not native");
        require(msg.value == amountIn, "value");
        amountOut = amountIn * rate;
        require(amountOut >= minAmountOut, "SlippageExceeded");
        BurnableToken(Currency.unwrap(key.currency1)).mint(recipient, amountOut);
        calls++;
    }
}

/// @dev Stands in for PairPadLaunchFactory.launchTokenFor: deploys a
/// burnable token and records the launch the way the real factory does.
contract MockFactory is INeuronLaunchFactory {
    uint256 public launchFee = 0.0005 ether;
    address public launchForwarder;
    address public lastDeployer;
    mapping(address token => address) public creatorFeeRecipientOf;

    function setForwarder(address f) external {
        launchForwarder = f;
    }

    function launchTokenFor(
        PairPadLaunchFactory.TokenParams calldata params,
        uint256,
        address pairToken,
        address originalDeployer
    ) external payable returns (address token, PoolId poolId) {
        require(msg.sender == launchForwarder, "NotLaunchForwarder");
        require(msg.value == launchFee, "LaunchFeeNotPaid");
        require(pairToken == address(0), "pair");
        token = address(new BurnableToken(params.name, params.symbol));
        creatorFeeRecipientOf[token] = params.creatorFeeRecipient;
        lastDeployer = originalDeployer;
        poolId = PoolId.wrap(bytes32(0));
    }

    function poolKeyFor(address token) external pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 10_000,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
    }
}

contract GreedyCreator {
    NeuronParentSplitter public splitter;
    uint256 public reentries;

    function setSplitter(NeuronParentSplitter s) external {
        splitter = s;
    }

    receive() external payable {
        // Tries to be paid twice; the reentrancy guard must stop it.
        if (reentries == 0) {
            reentries++;
            splitter.payCreator();
        }
    }
}

contract NeuronTest is Test {
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    PairPadFeeEscrow escrow;
    MockRouter router;
    MockFactory factory;
    NeuronParentRegistry registry;
    NeuronLauncher launcher;
    BurnableToken parent;

    function setUp() public {
        escrow = new PairPadFeeEscrow();
        router = new MockRouter();
        factory = new MockFactory();
        registry = new NeuronParentRegistry(owner, operator);
        launcher = new NeuronLauncher(
            owner,
            INeuronLaunchFactory(address(factory)),
            INeuronSwapRouter(address(router)),
            INeuronRegistryListing(address(registry)),
            IPairPadFeeEscrow(address(escrow)),
            5000
        );
        factory.setForwarder(address(launcher));
        parent = new BurnableToken("Parent", "PRNT");
        vm.prank(owner);
        registry.setParent(address(parent), _route(address(parent), address(0)));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _route(address token, address hook) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 10_000,
            tickSpacing: 10,
            hooks: IHooks(hook)
        });
    }

    function _params() internal pure returns (PairPadLaunchFactory.TokenParams memory p) {
        p.name = "Harbor Cat";
        p.symbol = "HCAT";
        p.socials = PairPadLauncherToken.Socials("", "", "", "", "");
    }

    function _launch(address who, uint256 devBuy) internal returns (address token, NeuronParentSplitter splitter) {
        uint256 value = factory.launchFee() + devBuy;
        vm.prank(who);
        (address t, address s,) = launcher.launch{value: value}(_params(), address(parent), 0);
        return (t, NeuronParentSplitter(payable(s)));
    }

    /// @dev What the locker does on a fee collection: credit ETH to the recipient.
    function _creditEth(address recipient, uint256 amount) internal {
        vm.deal(address(this), amount);
        escrow.credit{value: amount}(recipient);
    }

    function _creditTokens(address token, address recipient, uint256 amount) internal {
        BurnableToken(token).mint(address(this), amount);
        BurnableToken(token).approve(address(escrow), amount);
        escrow.creditToken(recipient, token, amount);
    }

    // ---------------------------------------------------------------- registry

    function test_Registry_OnlyOwnerLists() public {
        BurnableToken other = new BurnableToken("O", "O");
        vm.expectRevert();
        registry.setParent(address(other), _route(address(other), address(0)));
    }

    function test_Registry_RejectsRouteNotEthToParent() public {
        BurnableToken other = new BurnableToken("O", "O");
        PoolKey memory bad = _route(address(other), address(0));
        bad.currency0 = Currency.wrap(address(0x1234));
        vm.prank(owner);
        vm.expectRevert(NeuronParentRegistry.RouteNotEthToParent.selector);
        registry.setParent(address(other), bad);

        vm.prank(owner);
        vm.expectRevert(NeuronParentRegistry.RouteNotEthToParent.selector);
        registry.setParent(address(other), _route(address(parent), address(0)));
    }

    function test_Registry_HookMustBeAllowed() public {
        BurnableToken other = new BurnableToken("O", "O");
        address hook = address(0xB00C);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(NeuronParentRegistry.HookNotAllowed.selector, hook));
        registry.setParent(address(other), _route(address(other), hook));

        vm.startPrank(owner);
        registry.setHookAllowed(hook, true);
        registry.setParent(address(other), _route(address(other), hook));
        vm.stopPrank();
        assertTrue(registry.isListed(address(other)));
    }

    function test_Registry_DelistKeepsRoute() public {
        vm.prank(owner);
        registry.delistParent(address(parent));
        assertFalse(registry.isListed(address(parent)));
        PoolKey memory r = registry.routeOf(address(parent));
        assertEq(Currency.unwrap(r.currency1), address(parent));
    }

    function test_Registry_UnknownParentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(NeuronParentRegistry.UnknownParent.selector, address(0xABC)));
        registry.routeOf(address(0xABC));
    }

    function test_Registry_CannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(NeuronParentRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
    }

    // ---------------------------------------------------------------- launcher

    function test_Launch_WiresSplitterAndRecordsLaunch() public {
        (address token, NeuronParentSplitter splitter) = _launch(alice, 0);
        assertEq(factory.creatorFeeRecipientOf(token), address(splitter));
        assertEq(factory.lastDeployer(), alice);
        assertEq(splitter.child(), token);
        assertEq(splitter.parent(), address(parent));
        assertEq(splitter.creator(), alice);
        assertEq(splitter.parentShareBps(), 5000);
        (address p, address s, address c,) = launcher.launches(token);
        assertEq(p, address(parent));
        assertEq(s, address(splitter));
        assertEq(c, alice);
        assertEq(launcher.launchCount(), 1);
    }

    function test_Launch_IgnoresCallerFeeRecipient() public {
        PairPadLaunchFactory.TokenParams memory p = _params();
        p.creatorFeeRecipient = bob;
        uint256 fee = factory.launchFee();
        vm.prank(alice);
        (address token, address splitter,) = launcher.launch{value: fee}(p, address(parent), 0);
        assertEq(factory.creatorFeeRecipientOf(token), splitter);
    }

    function test_Launch_RejectsUnlistedParent() public {
        vm.prank(owner);
        registry.delistParent(address(parent));
        uint256 fee = factory.launchFee();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuronLauncher.ParentNotListed.selector, address(parent)));
        launcher.launch{value: fee}(_params(), address(parent), 0);
    }

    function test_Launch_RejectsFeeShortfall() public {
        uint256 fee = factory.launchFee();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuronLauncher.LaunchFeeNotCovered.selector, fee - 1, fee));
        launcher.launch{value: fee - 1}(_params(), address(parent), 0);
    }

    function test_Launch_DevBuyGoesToCaller() public {
        (address token,) = _launch(alice, 1 ether);
        assertEq(ERC20(token).balanceOf(alice), 1 ether * router.rate());
        assertEq(address(launcher).balance, 0);
    }

    function test_Launch_DevBuyRespectsSlippage() public {
        uint256 fee = factory.launchFee();
        uint256 floor = 1 ether * router.rate() + 1;
        vm.prank(alice);
        vm.expectRevert(bytes("SlippageExceeded"));
        launcher.launch{value: fee + 1 ether}(_params(), address(parent), floor);
    }

    function test_Launcher_ParentShareBounded() public {
        vm.prank(owner);
        vm.expectRevert(NeuronLauncher.InvalidBps.selector);
        launcher.setParentShareBps(10_001);
        vm.prank(owner);
        launcher.setParentShareBps(3000);
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        assertEq(splitter.parentShareBps(), 3000);
    }

    function test_Launcher_OnlyOwnerSetsShare() public {
        vm.prank(alice);
        vm.expectRevert();
        launcher.setParentShareBps(1000);
    }

    // ---------------------------------------------------------------- splitter

    function test_Splitter_OnlyLauncherBindsOnce() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        vm.expectRevert(NeuronParentSplitter.NotLauncher.selector);
        splitter.bindChild(address(1));
        vm.prank(address(launcher));
        vm.expectRevert(NeuronParentSplitter.AlreadyBound.selector);
        splitter.bindChild(address(1));
    }

    function test_Splitter_SplitsEth() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 1 ether + 1);
        splitter.sync();
        // Odd wei: the Parent gets the floor, the creator the remainder.
        assertEq(splitter.parentEth(), 0.5 ether);
        assertEq(splitter.creatorEth(), 0.5 ether + 1);
        assertEq(address(splitter).balance, 1 ether + 1);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    function test_Splitter_DirectEthIsSplitToo() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        vm.prank(bob);
        (bool ok,) = address(splitter).call{value: 2 ether}("");
        assertTrue(ok);
        splitter.sync();
        assertEq(splitter.parentEth(), 1 ether);
        assertEq(splitter.creatorEth(), 1 ether);
    }

    function test_Splitter_SyncIsIdempotent() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 1 ether);
        splitter.sync();
        splitter.sync();
        assertEq(splitter.parentEth() + splitter.creatorEth(), 1 ether);
    }

    function test_Splitter_SplitsChildTokens() public {
        (address token, NeuronParentSplitter splitter) = _launch(alice, 0);
        uint256 supplyBefore = ERC20(token).totalSupply();
        _creditTokens(token, address(splitter), 1000);
        splitter.sync();
        assertEq(ERC20(token).balanceOf(alice), 500);
        assertEq(ERC20(token).balanceOf(address(splitter)), 0);
        assertEq(ERC20(token).totalSupply(), supplyBefore + 1000 - 500);
        assertEq(splitter.totalChildBurned(), 500);
        assertEq(splitter.totalChildToCreator(), 500);
    }

    function test_Splitter_PayCreator() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        uint256 before = alice.balance;
        vm.prank(bob); // anyone may trigger; money only goes to the creator
        uint256 paid = splitter.payCreator();
        assertEq(paid, 1 ether);
        assertEq(alice.balance - before, 1 ether);
        assertEq(splitter.creatorEth(), 0);
        assertEq(splitter.parentEth(), 1 ether);
        assertEq(address(splitter).balance, 1 ether);
    }

    function test_Splitter_PayCreatorBlocksReentry() public {
        GreedyCreator greedy = new GreedyCreator();
        vm.deal(address(greedy), 1 ether);
        uint256 fee = factory.launchFee();
        vm.prank(address(greedy));
        (, address s,) = launcher.launch{value: fee}(_params(), address(parent), 0);
        NeuronParentSplitter splitter = NeuronParentSplitter(payable(s));
        greedy.setSplitter(splitter);
        _creditEth(address(splitter), 2 ether);
        // The re-entrant call reverts, so the payment fails as a whole.
        vm.expectRevert(NeuronParentSplitter.TransferFailed.selector);
        splitter.payCreator();
        assertEq(splitter.creatorEth(), 0); // sync did not persist either
        assertEq(escrow.balanceOf(address(splitter)), 2 ether);
    }

    function test_Splitter_BuybackBurnsParent() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        vm.prank(operator);
        uint256 out = splitter.buybackParent(0.4 ether, 0);
        assertEq(out, 0.4 ether * router.rate());
        assertEq(parent.balanceOf(DEAD), out);
        assertEq(parent.balanceOf(address(splitter)), 0);
        assertEq(splitter.parentEth(), 0.6 ether);
        assertEq(splitter.creatorEth(), 1 ether);
        assertEq(splitter.totalParentEthSpent(), 0.4 ether);
        assertEq(splitter.totalParentBurned(), out);
        assertEq(address(splitter).balance, 1.6 ether);
    }

    function test_Splitter_BuybackOnlyOperator() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        vm.prank(alice);
        vm.expectRevert(NeuronParentSplitter.NotOperator.selector);
        splitter.buybackParent(0.1 ether, 0);
    }

    function test_Splitter_BuybackFollowsOperatorRotation() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        address newOp = makeAddr("newOp");
        vm.prank(owner);
        registry.setOperator(newOp);
        vm.prank(operator);
        vm.expectRevert(NeuronParentSplitter.NotOperator.selector);
        splitter.buybackParent(0.1 ether, 0);
        vm.prank(newOp);
        splitter.buybackParent(0.1 ether, 0);
    }

    function test_Splitter_BuybackCannotSpendCreatorEth() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(NeuronParentSplitter.InsufficientParentEth.selector, 1 ether + 1, 1 ether)
        );
        splitter.buybackParent(1 ether + 1, 0);
    }

    function test_Splitter_BuybackRespectsSlippage() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        uint256 floor = 0.1 ether * router.rate() + 1;
        vm.prank(operator);
        vm.expectRevert(bytes("SlippageExceeded"));
        splitter.buybackParent(0.1 ether, floor);
        assertEq(splitter.parentEth(), 0); // reverted before sync persisted
    }

    function test_Splitter_BuybackWorksAfterDelist() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        vm.prank(owner);
        registry.delistParent(address(parent));
        _creditEth(address(splitter), 2 ether);
        vm.prank(operator);
        splitter.buybackParent(1 ether, 0);
        assertEq(splitter.parentEth(), 0);
    }

    function test_Splitter_ZeroBuybackReverts() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        vm.prank(operator);
        vm.expectRevert(NeuronParentSplitter.ZeroAmount.selector);
        splitter.buybackParent(0, 0);
    }

    function test_Splitter_CreatorTransferIsTwoStep() public {
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        _creditEth(address(splitter), 2 ether);
        vm.prank(bob);
        vm.expectRevert(NeuronParentSplitter.NotCreator.selector);
        splitter.transferCreator(bob);

        vm.prank(alice);
        splitter.transferCreator(bob);
        assertEq(splitter.creator(), alice);
        vm.prank(alice);
        vm.expectRevert(NeuronParentSplitter.NotPendingCreator.selector);
        splitter.acceptCreator();

        vm.prank(bob);
        splitter.acceptCreator();
        assertEq(splitter.creator(), bob);
        uint256 before = bob.balance;
        splitter.payCreator();
        assertEq(bob.balance - before, 1 ether);
    }

    function test_Splitter_UnboundCannotSync() public {
        NeuronParentSplitter lone = new NeuronParentSplitter(
            IPairPadFeeEscrow(address(escrow)),
            INeuronSwapRouter(address(router)),
            INeuronParentRegistry(address(registry)),
            address(parent),
            alice,
            5000
        );
        vm.expectRevert(NeuronParentSplitter.NotBound.selector);
        lone.sync();
    }

    function test_Splitter_RejectsBadConstructorArgs() public {
        vm.expectRevert(NeuronParentSplitter.InvalidBps.selector);
        new NeuronParentSplitter(
            IPairPadFeeEscrow(address(escrow)),
            INeuronSwapRouter(address(router)),
            INeuronParentRegistry(address(registry)),
            address(parent),
            alice,
            10_001
        );
        vm.expectRevert(NeuronParentSplitter.ZeroAddress.selector);
        new NeuronParentSplitter(
            IPairPadFeeEscrow(address(escrow)),
            INeuronSwapRouter(address(router)),
            INeuronParentRegistry(address(registry)),
            address(0),
            alice,
            5000
        );
    }

    // ------------------------------------------------------------------- fuzz

    /// @dev No wei is created or lost: every split adds up, and after paying
    /// the creator and spending all Parent ETH the splitter holds nothing.
    function testFuzz_Splitter_ConservesEth(uint96 a, uint96 b, uint16 bps) public {
        bps = uint16(bound(bps, 0, 10_000));
        vm.prank(owner);
        launcher.setParentShareBps(bps);
        (, NeuronParentSplitter splitter) = _launch(alice, 0);
        if (a > 0) _creditEth(address(splitter), a);
        if (b > 0) _creditEth(address(splitter), b);
        splitter.sync();
        uint256 total = uint256(a) + uint256(b);
        assertEq(splitter.parentEth() + splitter.creatorEth(), total);
        // Both credits are claimed and split in one sync.
        assertEq(splitter.parentEth(), total * bps / 10_000);

        uint256 aliceBefore = alice.balance;
        splitter.payCreator();
        assertEq(alice.balance - aliceBefore, total - splitter.parentEth());
        uint256 pe = splitter.parentEth();
        if (pe > 0) {
            vm.prank(operator);
            splitter.buybackParent(pe, 0);
        }
        assertEq(address(splitter).balance, 0);
        assertEq(splitter.totalParentEthSpent() + splitter.totalCreatorEthPaid(), total);
    }

    function testFuzz_Splitter_ChildTokenSplitAddsUp(uint128 amount, uint16 bps) public {
        bps = uint16(bound(bps, 0, 10_000));
        vm.prank(owner);
        launcher.setParentShareBps(bps);
        (address token, NeuronParentSplitter splitter) = _launch(alice, 0);
        vm.assume(amount > 0);
        _creditTokens(token, address(splitter), amount);
        splitter.sync();
        assertEq(splitter.totalChildBurned() + splitter.totalChildToCreator(), amount);
        assertEq(splitter.totalChildBurned(), uint256(amount) * bps / 10_000);
        assertEq(ERC20(token).balanceOf(address(splitter)), 0);
    }
}
