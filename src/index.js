const Wallet = require("./wallet").Wallet;

MINT_HOST = "127.0.0.1";
MINT_PORT = 3338;
MINT_SERVER = `http://${MINT_HOST}:${MINT_PORT}`;

console.log(`Using mint '${MINT_SERVER}'`);

async function run() {
  const wallet = new Wallet();
  await wallet.loadMint();

  const command = process.argv[2];
  switch (command) {
    case "invoice":
      // either without hash, then minting of tokens is requested
      // or with hash, then tokens are minted
      var amount = +process.argv[3];
      var resp;
      if (process.argv.length == 5) {
        const hash = process.argv[4];
        resp = await wallet.mint(amount, hash);
      } else {
        resp = await wallet.requestMint(amount);
      }
      console.log("Mint response:");
      console.log(resp);
      break;
    case "send":
      var amount = +process.argv[3];
      let { _, scndProofs } = await wallet.splitToSend(
        wallet.proofs,
        amount,
        (invalidate = true)
      );
      console.log("Send:");
      console.log(wallet.serializeProofs(scndProofs));
      break;
    case "receive":
      let tokenBase64 = process.argv[3];
      let proofs = JSON.parse(atob(tokenBase64));
      await wallet.redeem(proofs);
      break;
    case "balance":
      break;
    default:
      console.log(`Command '${command}' not supported`);
      break;
  }
  console.log(`Balance: ${wallet.sumProofs(wallet.proofs)}`);
}

try {
  run();
} catch (error) {
  console.log(error);
}
