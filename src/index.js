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
    case "mint":
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
      var resp;
      let { _, scndProofs } = await wallet.splitToSend(wallet.proofs, amount);
      console.log("Send result:");
      console.log(scndProofs);
      break;
    default:
      console.log(`Command '${command}' not supported`);
      break;
  }
}

try {
  run();
} catch (error) {
  console.log(error);
}
