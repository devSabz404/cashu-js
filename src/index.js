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
      const amount = +process.argv[3];
      var resp;
      if (process.argv.length == 5) {
        const hash = process.argv[4];
        resp = await wallet.mint(amount, hash);
      } else {
        resp = await wallet.requestMint(amount);
      }
      console.log(resp);
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
