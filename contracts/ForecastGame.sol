// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IForecastGameFactory {
    function factoryOwner() external view returns (address);
}

contract ForecastGame {
    struct Bet {
        uint8 option;
        uint256 amount;
        bool hasClaimed;
    }

    uint256 public totalWinners;
    uint256 public claimedWinners;
    address public creator;
    address public factory;
    uint256 public pool;
    string public question;
    string[] public options;
    uint8[] public odds;
    uint256[] public oddAccumulate;
    uint8 public finalOption;
    bool public gameFinalized;
    bool public gameActive;

    mapping(address => Bet) public players;
    address[] public playersList;
    address[] public winners;

    event BetPlaced(address indexed p, uint8 o, uint256 a);
    event GameFinalized(uint8 o);
    event PrizeClaimed(address indexed p, uint256 a);
    event PoolFunded(uint256 a);

    modifier onlyCreator() {
        require(msg.sender == creator);
        _;
    }

    modifier onlyFactoryOwner() {
        require(msg.sender == IForecastGameFactory(factory).factoryOwner());
        _;
    }

    modifier gameIsActive() {
        require(gameActive && !gameFinalized);
        _;
    }

    modifier gameIsFinalized() {
        require(gameFinalized);
        _;
    }

    constructor(
        address _creator,
        string memory _question,
        string[] memory _options,
        uint8[] memory _odds
    ) payable {
        require(_options.length > 0 && _options.length == _odds.length && _options.length <= 10);
        factory = msg.sender;
        creator = _creator;
        question = _question;
        options = _options;
        odds = _odds;
        pool = msg.value;
        gameActive = true;
        oddAccumulate = new uint256[](_options.length);
        if (msg.value > 0) emit PoolFunded(msg.value);
    }

    function fundPool() external payable onlyCreator {
        require(msg.value > 0);
        pool += msg.value;
        emit PoolFunded(msg.value);
    }

    function bet(uint8 _option) external payable gameIsActive {
        require(_option > 0 && _option <= options.length);
        require(players[msg.sender].amount == 0);
        require(msg.value > 0);
        uint8 idx = _option - 1;
        uint256 prize = (msg.value * odds[idx]) / 100;
        uint256 maxPayout = _findMax(oddAccumulate) + prize;
        require(maxPayout <= pool);
        oddAccumulate[idx] += prize;
        players[msg.sender] = Bet(_option, msg.value, false);
        playersList.push(msg.sender);
        emit BetPlaced(msg.sender, _option, msg.value);
    }

    function finalize(uint8 _finalOption) external onlyFactoryOwner gameIsActive {
        require(_finalOption > 0 && _finalOption <= options.length);
        finalOption = _finalOption;
        gameFinalized = true;
        gameActive = false;
        uint256 count;
        for (uint256 i = 0; i < playersList.length; i++) {
            address p = playersList[i];
            if (players[p].option == _finalOption) {
                winners.push(p);
                count++;
            }
        }
        totalWinners = count;
        claimedWinners = 0;
        emit GameFinalized(_finalOption);
    }

    function claimPrize() external gameIsFinalized {
        Bet storage b = players[msg.sender];
        require(b.amount > 0 && b.option == finalOption && !b.hasClaimed);
        uint256 prize = (b.amount * odds[finalOption - 1]) / 100;
        require(address(this).balance >= prize);
        b.hasClaimed = true;
        claimedWinners++;
        pool -= prize;
        payable(msg.sender).transfer(prize);
        emit PrizeClaimed(msg.sender, prize);
    }

    function withdrawRemainingPool() external onlyCreator gameIsFinalized {
        require(pool > 0 && claimedWinners == totalWinners);
        uint256 amount = pool;
        pool = 0;
        payable(creator).transfer(amount);
    }

    function emergencyWithdraw() external onlyCreator {
        require(!gameActive || gameFinalized);
        uint256 amount = address(this).balance;
        payable(creator).transfer(amount);
    }

    function _findMax(uint256[] memory arr) internal pure returns (uint256 m) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] > m) m = arr[i];
        }
    }

    receive() external payable {
        pool += msg.value;
        emit PoolFunded(msg.value);
    }
}

contract ForecastGameFactory {
    struct GameInfo {
        address gameAddress;
        address creator;
        string question;
        uint256 createdAt;
        bool isActive;
    }

    address public factoryOwner;
    uint256 public feePercent;
    uint256 public gameCount;
    mapping(uint256 => GameInfo) public games;
    mapping(address => uint256[]) public creatorGames;
    uint256[] public allGameIds;

    event GameCreated(uint256 indexed id, address indexed addr, address indexed c, string q);

    modifier onlyFactoryOwner() {
        require(msg.sender == factoryOwner);
        _;
    }

    constructor(uint256 _feePercent) {
        require(_feePercent <= 100);
        factoryOwner = msg.sender;
        feePercent = _feePercent;
    }

    function createGame(
        string memory _question,
        string[] memory _options,
        uint8[] memory _odds
    ) external payable returns (address addr, uint256 id) {
        require(bytes(_question).length > 0 && _options.length > 0 && _options.length == _odds.length && msg.value > 0);
        uint256 fee = (msg.value * feePercent) / 100;
        uint256 remain = msg.value - fee;
        if (fee > 0) payable(factoryOwner).transfer(fee);
        ForecastGame g = new ForecastGame{value: remain}(msg.sender, _question, _options, _odds);
        addr = address(g);
        id = gameCount;
        games[id] = GameInfo(addr, msg.sender, _question, block.timestamp, true);
        creatorGames[msg.sender].push(id);
        allGameIds.push(id);
        gameCount++;
        emit GameCreated(id, addr, msg.sender, _question);
    }

    function markGameInactive(uint256 _id) external {
        require(_id < gameCount && games[_id].creator == msg.sender);
        games[_id].isActive = false;
    }

    function updateFactoryOwner(address _new) external onlyFactoryOwner {
        require(_new != address(0));
        factoryOwner = _new;
    }
}
