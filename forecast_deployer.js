// forecast_deployer.js

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");
const sqlite3 = require("sqlite3").verbose();
require("dotenv").config(); // Load environment variables from .env file

// --- Configuration ---
const SOL_FILE_PATH = path.resolve(__dirname, "contracts", "ForecastGame.sol");
const INFURA_API_KEY = process.env.INFURA_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FACTORY_FEE_PERCENT = process.env.FACTORY_FEE_PERCENT; // Example: 5% fee
const SEPOLIA_CHAIN_ID = 11155111;
const DB_FILE_PATH = path.resolve(__dirname, "contracts.db");

// --- Global Variables for Logging ---
let db;
let currentDeploymentId = null; // Will store the ID of the current deployment attempt

// --- Database Initialization ---
function initDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_FILE_PATH, (err) => {
      if (err) {
        console.error("Error opening database:", err.message);
        reject(err);
        return;
      }
      console.log("Connected to the SQLite database.");

      // Create deployed_contracts table
      db.run(
        `CREATE TABLE IF NOT EXISTS deployed_contracts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contract_name TEXT NOT NULL,
                address TEXT UNIQUE, -- Address can be NULL initially if deployment fails
                abi TEXT,
                bytecode TEXT,
                deployed_at DATETIME,
                status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, DEPLOYED, FAILED
                chain_id INTEGER,
                compiler_version TEXT
            )`,
        (err) => {
          if (err) {
            console.error(
              "Error creating deployed_contracts table:",
              err.message
            );
            reject(err);
            return;
          }
          console.log('Table "deployed_contracts" ensured.');

          // Create deployment_logs table with foreign key
          db.run(
            `CREATE TABLE IF NOT EXISTS deployment_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    deployment_id INTEGER NOT NULL,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    log_level TEXT NOT NULL,
                    message TEXT NOT NULL,
                    FOREIGN KEY (deployment_id) REFERENCES deployed_contracts(id)
                )`,
            (err) => {
              if (err) {
                console.error(
                  "Error creating deployment_logs table:",
                  err.message
                );
                reject(err);
                return;
              }
              console.log('Table "deployment_logs" ensured.');
              resolve();
            }
          );
        }
      );
    });
  });
}

// --- Custom Logger Function ---
async function logMessage(level, message) {
  console.log(`[${level}] ${message}`); // Always log to console

  if (!db) {
    console.warn("Database not initialized. Cannot save log to DB:", message);
    return;
  }

  // If currentDeploymentId is null, it means we haven't even inserted the pending contract yet.
  // In this specific scenario (e.g., initial DB connection error, or pre-initial-insert errors),
  // we log to console but cannot save to DB with a linked ID.
  // However, with the 'PENDING' status approach, currentDeploymentId should be available early.

  // We'll insert with currentDeploymentId. If currentDeploymentId is null at this point,
  // it indicates a very early failure, or a log message before a deployment attempt ID is assigned.
  // For this design, we expect currentDeploymentId to be set before the main logic.
  if (currentDeploymentId === null) {
    console.warn(
      `Attempted to log "${message}" without a deployment ID. This log will not be stored in DB.`
    );
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO deployment_logs (deployment_id, log_level, message) VALUES (?, ?, ?)`,
        [currentDeploymentId, level, message],
        function (err) {
          if (err) {
            console.error("Error saving log to database:", err.message);
            reject(err);
          } else {
            // console.log(`Log saved: ${this.lastID}`); // Too verbose for every log
            resolve();
          }
        }
      );
    });
  } catch (err) {
    // Error already logged by console.error above. No need to re-log.
  }
}

// --- Main Deployment Function ---
async function deployForecastFactory() {
  await initDb(); // Initialize database and tables

  // 1. Insert a 'PENDING' entry into deployed_contracts to get an ID for logging
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO deployed_contracts (contract_name, status) VALUES (?, ?)`,
        ["ForecastGameFactory", "PENDING"],
        function (err) {
          if (err) {
            console.error(
              "Error inserting initial pending contract:",
              err.message
            );
            reject(err);
          } else {
            currentDeploymentId = this.lastID;
            logMessage(
              "INFO",
              `Started deployment process for ForecastGameFactory (ID: ${currentDeploymentId}).`
            );
            resolve();
          }
        }
      );
    });
  } catch (error) {
    await logMessage(
      "ERROR",
      `Fatal: Could not initialize deployment record in DB. Aborting. Error: ${error.message}`
    );
    if (db) db.close();
    return;
  }

  try {
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

    // Pass the constructor argument(s) to the deploy method
    const deployedFactory = await factoryContractFactory.deploy(
      FACTORY_FEE_PERCENT
    );

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
    await new Promise((resolve, reject) => {
      db.run(
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
        ],
        function (err) {
          if (err) {
            console.error("Error updating deployed_contracts:", err.message);
            reject(err);
          } else {
            logMessage(
              "INFO",
              `Contract details updated in DB for ID: ${currentDeploymentId}`
            );
            resolve();
          }
        }
      );
    });
  } catch (error) {
    await logMessage(
      "ERROR",
      `Deployment failed for ID ${currentDeploymentId}. Error: ${error.message}`
    );
    // Update status to FAILED if an error occurred after initial PENDING insert
    if (currentDeploymentId !== null) {
      await new Promise((resolve) => {
        db.run(
          `UPDATE deployed_contracts SET status = 'FAILED' WHERE id = ?`,
          [currentDeploymentId],
          function (err) {
            if (err) {
              console.error(
                "Error updating contract status to FAILED:",
                err.message
              );
            } else {
              console.log(
                `Deployment status set to FAILED for ID: ${currentDeploymentId}`
              );
            }
            resolve(); // Ensure this promise resolves even if update fails
          }
        );
      });
    }
  } finally {
    if (db) {
      await logMessage("INFO", "Closing database connection.");
      db.close((err) => {
        if (err) {
          console.error("Error closing database:", err.message);
        } else {
          console.log("Database connection closed.");
        }
      });
    }
  }
}

// --- Run the Deployment ---
deployForecastFactory();
