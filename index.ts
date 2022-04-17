import { readFile } from "fs/promises";
import yargs from "yargs";
import { Jupiter, getPlatformFeeAccounts } from "@jup-ag/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  Signer,
} from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const spl = require("@solana/spl-token");

const CLUSTER = "mainnet-beta";
const SOLANA_RPC_ENDPOINT = "https://solana-api.projectserum.com";

const KEYPAIR_USER = "./keypair_alice.json";
const KEYPAIR_COLLECTOR = "./keypair_bob.json";

const MINT_SOL = new PublicKey("So11111111111111111111111111111111111111112");
const MINT_USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function main() {
  const args = await getArgs();
  const handler = {
    "accounts-print": accountsPrint,
    "accounts-create": accountsCreate,
    "accounts-close": accountsClose,
    swap: swap,
  }[args._[0]];
  if (handler === undefined) {
    throw new Error("Unknown command");
  }

  const info = await loadScriptInfo();
  await handler(args, info);
  process.exit(0);
}

type ArgvParsed = {
  _: (string | number)[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [index: string]: any;
};

async function getArgs(): Promise<ArgvParsed> {
  return await yargs(process.argv.slice(2))
    .version()
    .help("help")
    .alias("help", "h")
    .command("accounts-print", "Print SOL/USDC accounts")
    .command("accounts-create", "Create USDC/wSOL token accounts")
    .command("accounts-close", "Close USDC token accounts, withdraw all SOL", {
      receiver: {
        demandOption: true,
        description: "Address for receiving SOL / USDC",
        type: "string",
      },
    })
    .command("swap", "Make swap, all USDC or 90% of SOL").argv;
}

type ScriptInfo = {
  sol: {
    user: Keypair;
    collector: Keypair;
  };
  wsol: {
    user: PublicKey;
    collector: PublicKey;
  };
  usdc: {
    user: PublicKey;
    collector: PublicKey;
  };
  balances: {
    sol: { user: number; collector: number };
    wsol: { user: number; collector: number };
    usdc: { user: number; collector: number };
  };
  connection: Connection;
  jupiter: Jupiter;
};

async function loadScriptInfo(): Promise<ScriptInfo> {
  const [user, collector] = await Promise.all([
    loadKeypair(KEYPAIR_USER),
    loadKeypair(KEYPAIR_COLLECTOR),
  ]);

  const connection = new Connection(SOLANA_RPC_ENDPOINT);

  const [userUsdc, collectorUsdc, userWsol, collectorWsol] = await Promise.all([
    spl.getAssociatedTokenAddress(MINT_USDC, user.publicKey),
    spl.getAssociatedTokenAddress(MINT_USDC, collector.publicKey),
    spl.getAssociatedTokenAddress(MINT_SOL, user.publicKey),
    spl.getAssociatedTokenAddress(MINT_SOL, collector.publicKey),
  ]);

  const [userBalance, collectorBalance] = await Promise.all([
    connection.getBalance(user.publicKey),
    connection.getBalance(collector.publicKey),
  ]);
  const [
    userUsdcBalance,
    collectorUsdcBalance,
    userWsolBalance,
    collectorWsolBalance,
  ] = await Promise.all([
    getTokenBalance(connection, userUsdc),
    getTokenBalance(connection, collectorUsdc),
    getTokenBalance(connection, userWsol),
    getTokenBalance(connection, collectorWsol),
  ]);

  return {
    sol: {
      user,
      collector,
    },
    wsol: {
      user: userWsol,
      collector: collectorWsol,
    },
    usdc: {
      user: userUsdc,
      collector: collectorUsdc,
    },
    balances: {
      sol: {
        user: userBalance,
        collector: collectorBalance,
      },
      wsol: {
        user: Number(userWsolBalance),
        collector: Number(collectorWsolBalance),
      },
      usdc: {
        user: Number(userUsdcBalance),
        collector: Number(collectorUsdcBalance),
      },
    },
    connection,
    jupiter: await Jupiter.load({
      connection,
      cluster: CLUSTER,
      user: user.publicKey,
      platformFeeAndAccounts: {
        feeBps: 255, // Limited by: [0, 255]
        feeAccounts: await getPlatformFeeAccounts(
          connection,
          collector.publicKey
        ),
      },
    }),
  };
}

async function loadKeypair(location: string): Promise<Keypair> {
  const data = await readFile(location, "utf-8");
  const secretKey = new Uint8Array(JSON.parse(data));
  return Keypair.fromSecretKey(secretKey);
}

async function getTokenBalance(
  connection: Connection,
  address: PublicKey
): Promise<bigint> {
  try {
    const account = await spl.getAccount(connection, address);
    return account.amount;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (
      error.name !== "TokenAccountNotFoundError" &&
      error.name !== "TokenInvalidAccountOwnerError"
    ) {
      throw error;
    }
    return 0n;
  }
}

async function accountsPrint(
  _argv: ArgvParsed,
  info: ScriptInfo
): Promise<void> {
  const userSol = info.balances.sol.user / 1e9;
  const userWsol = info.balances.wsol.user / 1e9;
  const userUsdc = info.balances.usdc.user / 1e6;
  const collectorSol = info.balances.sol.collector / 1e9;
  const collectorWsol = info.balances.wsol.collector / 1e9;
  const collectorUsdc = info.balances.usdc.collector / 1e6;

  console.log(`User SOL: ${info.sol.user.publicKey.toBase58()}    balance: ${userSol}
User wSOL: ${info.wsol.user.toBase58()}    balance: ${userWsol}
User USDC: ${info.usdc.user.toBase58()}    balance: ${userUsdc}
Collector SOL: ${info.sol.collector.publicKey.toBase58()}    balance: ${collectorSol}
Collector wSOL: ${info.wsol.collector.toBase58()}    balance: ${collectorWsol}
Collector USDC: ${info.usdc.collector.toBase58()}    balance: ${collectorUsdc}
For creating accounts top up user SOL address: ${info.sol.user.publicKey.toBase58()}`);
}

async function accountsCreate(
  _argv: ArgvParsed,
  info: ScriptInfo
): Promise<void> {
  const tx = new Transaction({ feePayer: info.sol.user.publicKey });
  for (const owner of [info.sol.user.publicKey, info.sol.collector.publicKey]) {
    for (const mint of [MINT_SOL, MINT_USDC]) {
      const address = await spl.getAssociatedTokenAddress(mint, owner);
      const account = await info.connection.getAccountInfo(address);
      if (account === null) {
        tx.add(
          spl.createAssociatedTokenAccountInstruction(
            info.sol.user.publicKey,
            address,
            owner,
            mint
          )
        );
      }
    }
  }
  if (tx.instructions.length === 0) {
    console.log("Noting to create");
  } else {
    const txid = await info.connection.sendTransaction(tx, [info.sol.user], {
      skipPreflight: true,
    });
    console.log(`send transaction: ${txid}`);
    await info.connection.confirmTransaction(txid);
    console.log(`transaction confirmed: ${txid}`);
  }
}

async function accountsClose(
  argv: ArgvParsed,
  info: ScriptInfo
): Promise<void> {
  const receiver = new PublicKey(argv.receiver);

  const tx = new Transaction({ feePayer: info.sol.user.publicKey });
  const signers = new Set();
  for (const owner of [info.sol.collector, info.sol.user]) {
    const response = await info.connection.getParsedTokenAccountsByOwner(
      owner.publicKey,
      { programId: spl.TOKEN_PROGRAM_ID }
    );
    for (const { account, pubkey } of response.value) {
      const mint = new PublicKey(account.data.parsed.info.mint);
      const amount = parseInt(account.data.parsed.info.tokenAmount.amount, 10);
      if (amount > 0 && !mint.equals(MINT_SOL)) {
        tx.add(
          spl.createTransferInstruction(
            pubkey,
            await spl.getAssociatedTokenAddress(mint, receiver),
            owner.publicKey,
            amount
          )
        );
      }
      tx.add(
        spl.createCloseAccountInstruction(pubkey, receiver, owner.publicKey)
      );
      signers.add(owner);
    }

    let balance = await info.connection.getBalance(owner.publicKey);
    if (balance > 0) {
      if (owner.publicKey.equals(info.sol.user.publicKey)) {
        balance -= signers.size * 5000;
      }
      tx.add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          lamports: balance,
          toPubkey: receiver,
        })
      );
      signers.add(owner);
    }
  }
  if (tx.instructions.length === 0) {
    console.log("Noting to close");
  } else {
    const signersArray = Array.from(signers) as unknown as Signer[];
    const txid = await info.connection.sendTransaction(tx, signersArray, {
      skipPreflight: true,
    });
    console.log(`send transaction: ${txid}`);
    await info.connection.confirmTransaction(txid);
    console.log(`transaction confirmed: ${txid}`);
  }
}

async function swap(_argv: ArgvParsed, info: ScriptInfo): Promise<void> {
  const opts = {
    inputMint: MINT_USDC,
    outputMint: MINT_SOL,
    inputAmount: info.balances.usdc.user,
    slippage: 1,
    // Set to `true` for better rate but will create additional token accounts
    onlyDirectRoutes: true,
  };
  if (info.balances.usdc.user === 0) {
    opts.inputMint = MINT_SOL;
    opts.outputMint = MINT_USDC;
    opts.inputAmount = Math.floor(info.balances.sol.user * 0.8);
  }
  const routes = await info.jupiter.computeRoutes(opts);

  // https://docs.jup.ag/jupiter-core/adding-platform-fees
  // No fees for `Raydium x Raydium`, this route need to be filtered.
  const routeInfo = routes.routesInfos[0];
  console.log("Route:", routeInfo);
  const exchange = await info.jupiter.exchange({
    routeInfo,
  });

  for (const step of [
    "setupTransaction",
    "swapTransaction",
    "cleanupTransaction",
  ] as const) {
    const tx = exchange.transactions[step];
    if (tx) {
      const txid = await info.connection.sendTransaction(tx, [info.sol.user], {
        skipPreflight: true,
      });
      console.log(`${step}, send transaction: ${txid}`);

      await info.connection.confirmTransaction(txid);
      console.log(`${step}, transaction confirmed: ${txid}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
