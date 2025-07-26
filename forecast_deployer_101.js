// forecast_deployer.js

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers"); // Using ethers.js for simplicity and modern usage
const mysql = require("mysql2/promise"); // Using mysql2 for MariaDB/MySQL with promise support
require("dotenv").config(); // Load environment variables from .env file

// --- Configuration ---
const SOL_FILE_PATH = path.resolve(__dirname, "contracts", "ForecastGame.sol"); // Assuming your .sol file is here
const INFURA_API_KEY = process.env.INFURA_API_KEY; // Loaded from .env
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Loaded from .env
const FACTORY_FEE_PERCENT = process.env.FACTORY_FEE_PERCENT; // Example: 5% fee, loaded from .env
const SEPOLIA_CHAIN_ID = 11155111;

// MariaDB Configuration
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost", // Replace with your MariaDB host or use .env
  user: process.env.DB_USER || "your_mariadb_user", // Replace with your MariaDB username or use .env
  password: process.env.DB_PASSWORD || "your_mariadb_password", // Replace with your MariaDB password or use .env
  database: process.env.DB_NAME || "your_database_name", // Replace with your database name or use .env
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let dbConnection; // Declare connection variable globally
let currentDeploymentId = null; // Will store the ID of the current deployment attempt for logging

// --- Database Initialization ---
async function initDb() {
  try {
    console.log("Attempting to connect to MariaDB...");
    dbConnection = await mysql.createConnection(DB_CONFIG);
    console.log("Connected to the MariaDB database.");

    // Create deployed_contracts table
    await dbConnection.execute(`
            CREATE TABLE IF NOT EXISTS deployed_contracts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                contract_name VARCHAR(255) NOT NULL,
                address VARCHAR(255) UNIQUE, -- Address can be NULL initially if deployment fails
                abi LONGTEXT,
                bytecode LONGTEXT,
                deployed_at DATETIME,
                status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- PENDING, DEPLOYED, FAILED
                chain_id INT,
                compiler_version VARCHAR(255)
            )
        `);
    console.log('Table "deployed_contracts" ensured.');

    // Create deployment_logs table with foreign key
    await dbConnection.execute(`
            CREATE TABLE IF NOT EXISTS deployment_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                deployment_id INT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                log_level VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                FOREIGN KEY (deployment_id) REFERENCES deployed_contracts(id) ON DELETE CASCADE
            )
        `);
    console.log('Table "deployment_logs" ensured.');
  } catch (err) {
    console.error("Error initializing database:", err.message);
    throw err; // Re-throw to be caught by the main deployment function
  }
}

// --- Custom Logger Function ---
async function logMessage(level, message) {
  console.log(`[${level}] ${message}`); // Always log to console

  if (!dbConnection) {
    console.warn(
      "Database connection not established. Cannot save log to DB:",
      message
    );
    return;
  }

  // If currentDeploymentId is null, it means we haven't even inserted the pending contract yet.
  // In this specific scenario (e.g., initial DB connection error, or pre-initial-insert errors),
  // we log to console but cannot save to DB with a linked ID.
  if (currentDeploymentId === null) {
    console.warn(
      `Attempted to log "${message}" without a deployment ID. This log will not be stored in DB.`
    );
    return;
  }

  try {
    await dbConnection.execute(
      `INSERT INTO deployment_logs (deployment_id, log_level, message) VALUES (?, ?, ?)`,
      [currentDeploymentId, level, message]
    );
  } catch (err) {
    console.error("Error saving log to database:", err.message);
  }
}

// --- Main Deployment Function ---
async function deployForecastFactory() {
  try {
    await initDb(); // Initialize database and tables

    // 1. Insert a 'PENDING' entry into deployed_contracts to get an ID for logging
    const [insertResult] = await dbConnection.execute(
      `INSERT INTO deployed_contracts (contract_name, status) VALUES (?, ?)`,
      ["ForecastGameFactory", "PENDING"]
    );
    currentDeploymentId = insertResult.insertId;
    await logMessage(
      "INFO",
      `Started deployment process for ForecastGameFactory (ID: ${currentDeploymentId}).`
    );

    // 2. Read Solidity Source
    await logMessage("INFO", `Reading Solidity source from: ${SOL_FILE_PATH}`);
    const sourceCode = fs.readFileSync(SOL_FILE_PATH, "utf8");

    // 3. Prepare Compiler Input
    const input = {
      language: "Solidity",
      sources: {
        "ForecastGame.sol": {
          content: sourceCode,
        },
      },
      settings: {
        outputSelection: {
          "*": {
            "*": ["abi", "evm.bytecode"],
          },
        },
        evmVersion: "london", // Or 'paris', or 'shanghai' depending on target EVM version
      },
    };

    // 4. Compile Solidity
    await logMessage("INFO", "Compiling Solidity contract...");
    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors) {
      let compilationErrors = "";
      output.errors.forEach((err) => {
        compilationErrors += err.formattedMessage + "\n";
        logMessage("ERROR", `Compilation Error: ${err.formattedMessage}`);
      });
      throw new Error(`Solidity compilation failed:\n${compilationErrors}`);
    }

    const factoryContractData =
      output.contracts["ForecastGame.sol"]["ForecastGameFactory"];
    if (!factoryContractData) {
      throw new Error(
        "ForecastGameFactory contract not found in compilation output."
      );
    }

    const factoryABI = JSON.stringify(factoryContractData.abi);
    const factoryBytecode = "0x" + factoryContractData.evm.bytecode.object;
    const compilerVersion = solc.version(); // Get the actual solc version used

    await logMessage("INFO", "Solidity compilation successful.");
    await logMessage("INFO", "ForecastGameFactory ABI and Bytecode extracted.");

    // 5. Set up Sepolia Provider and Wallet
    await logMessage("INFO", "Setting up Ethereum provider and wallet...");
    const provider = new ethers.InfuraProvider("sepolia", INFURA_API_KEY);
    if (!PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY environment variable is not set.");
    }
    if (!INFURA_API_KEY) {
      throw new Error("INFURA_API_KEY environment variable is not set.");
    }

    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const accountAddress = await wallet.getAddress();
    await logMessage("INFO", `Using wallet address: ${accountAddress}`);

    const balance = await provider.getBalance(accountAddress);
    await logMessage(
      "INFO",
      `Wallet balance: ${ethers.formatEther(balance)} ETH`
    );
    if (balance < ethers.parseEther("0.001")) {
      // Simple check, adjust as needed
      await logMessage(
        "WARNING",
        "Low ETH balance in wallet. Deployment might fail due to insufficient funds."
      );
    }

    // 6. Deploy ForecastGameFactory Contract
    await logMessage(
      "INFO",
      "Deploying ForecastGameFactory contract to Sepolia..."
    );
    const factoryContractFactory = new ethers.ContractFactory(
      factoryABI,
      factoryBytecode,
      wallet
    );

    // Validate FACTORY_FEE_PERCENT
    if (
      FACTORY_FEE_PERCENT === undefined ||
      isNaN(parseInt(FACTORY_FEE_PERCENT))
    ) {
      throw new Error(
        "FACTORY_FEE_PERCENT environment variable is not set or is not a valid number."
      );
    }
    const feePercent = parseInt(FACTORY_FEE_PERCENT);
    if (feePercent < 0 || feePercent > 100) {
      throw new Error("FACTORY_FEE_PERCENT must be between 0 and 100.");
    }
    await logMessage(
      "INFO",
      `Deploying with FACTORY_FEE_PERCENT: ${feePercent}%`
    );

    // Pass the constructor argument(s) to the deploy method
    const deployedFactory = await factoryContractFactory.deploy(feePercent);

    await logMessage(
      "INFO",
      "Transaction sent. Waiting for deployment confirmation..."
    );
    await logMessage(
      "INFO",
      `Deployment transaction hash: ${
        deployedFactory.deploymentTransaction().hash
      }`
    );

    await deployedFactory.waitForDeployment();

    const factoryAddress = await deployedFactory.getAddress();

    await logMessage(
      "INFO",
      `ForecastGameFactory deployed successfully to: ${factoryAddress}`
    );

    // 7. Update the deployed_contracts entry with final details
    await dbConnection.execute(
      `UPDATE deployed_contracts SET
                address = ?,
                abi = ?,
                bytecode = ?,
                deployed_at = CURRENT_TIMESTAMP,
                status = 'DEPLOYED',
                chain_id = ?,
                compiler_version = ?
                WHERE id = ?`,
      [
        factoryAddress,
        factoryABI,
        factoryBytecode,
        SEPOLIA_CHAIN_ID,
        compilerVersion,
        currentDeploymentId,
      ]
    );
    await logMessage(
      "INFO",
      `Contract details updated in DB for ID: ${currentDeploymentId}`
    );
  } catch (error) {
    await logMessage(
      "ERROR",
      `Deployment failed for ID ${currentDeploymentId}. Error: ${error.message}`
    );
    // Update status to FAILED if an error occurred after initial PENDING insert
    if (currentDeploymentId !== null) {
      try {
        await dbConnection.execute(
          `UPDATE deployed_contracts SET status = 'FAILED' WHERE id = ?`,
          [currentDeploymentId]
        );
        await logMessage(
          "INFO",
          `Deployment status set to FAILED for ID: ${currentDeploymentId}`
        );
      } catch (updateError) {
        console.error(
          "Error updating contract status to FAILED:",
          updateError.message
        );
      }
    }
  } finally {
    if (dbConnection) {
      await logMessage("INFO", "Closing database connection.");
      await dbConnection.end();
      console.log("MariaDB connection closed.");
    }
  }
}

// --- Run the Deployment ---
deployForecastFactory();
