const axios = require("axios").default;
const { utils, Point } = require("@noble/secp256k1");
const dhke = require("./dhke");
const { splitAmount, bytesToNumber, bigIntStringify } = require("./utils");
const { uint8ToBase64 } = require("./base64");

class Wallet {
  // --------- GET /keys

  async loadMint() {
    this.keys = await this.getKeysApi();
  }

  async getKeysApi() {
    const { data } = await axios.get(`${MINT_SERVER}/keys`);
    return data;
  }

  // --------- POST /mint

  async mintApi(amounts, paymentHash = "") {
    let secrets = await this.generateSecrets(amounts);
    let { outputs, rs } = await this.constructOutputs(amounts, secrets);
    let postMintRequest = { outputs: outputs };
    const postMintResponse = await axios.post(
      `${MINT_SERVER}/mint`,
      postMintRequest,
      {
        params: {
          payment_hash: paymentHash,
        },
      }
    );
    this.assertMintError(postMintResponse);
    let proofs = await this.constructProofs(
      postMintResponse.data.promises,
      secrets,
      rs
    );
    return proofs;
  }

  async mint(amount, hash) {
    try {
      const amounts = splitAmount(amount);
      const proofs = await this.mintApi(amounts, hash);
      return proofs;
    } catch (error) {
      console.log("Failed to execute 'mint' command");
      console.error(error);
    }
  }

  // --------- GET /mint

  async requestMintApi(amount) {
    const getMintResponse = await axios.get(`${MINT_SERVER}/mint`, {
      params: {
        amount: amount,
      },
    });
    this.assertMintError(getMintResponse);
    return getMintResponse.data;
  }

  async requestMint(amount) {
    try {
      const invoice = await this.requestMintApi(amount);
      return invoice;
    } catch (error) {
      console.log("Failed to execute 'mint' command");
      console.error(error);
    }
  }

  // --------- crypto

  generateSecrets(amounts) {
    const secrets = [];
    for (let i = 0; i < amounts.length; i++) {
      const secret = utils.randomBytes(32);
      secrets.push(secret);
    }
    return secrets;
  }

  async constructOutputs(amounts, secrets) {
    const outputs = [];
    const rs = [];
    for (let i = 0; i < amounts.length; i++) {
      const { B_, r } = await dhke.step1Alice(secrets[i]);
      outputs.push({ amount: amounts[i], B_: B_ });
      rs.push(r);
    }
    return {
      outputs,
      rs,
    };
  }

  constructProofs(promises, secrets, rs) {
    const proofs = [];
    for (let i = 0; i < promises.length; i++) {
      const encodedSecret = uint8ToBase64.encode(secrets[i]);
      let { id, amount, C, secret } = this.promiseToProof(
        promises[i].id,
        promises[i].amount,
        promises[i]["C_"],
        encodedSecret,
        rs[i]
      );
      proofs.push({ id, amount, C, secret });
    }
    return proofs;
  }

  promiseToProof(id, amount, C_hex, secret, r) {
    const C_ = Point.fromHex(C_hex);
    const A = this.keys[amount];
    const C = dhke.step3Alice(C_, utils.hexToBytes(r), Point.fromHex(A));
    return {
      id,
      amount,
      C: C.toHex(true),
      secret,
    };
  }

  // --------- utils

  sumProofs(proofs) {
    return proofs.reduce((s, t) => (s += t.amount), 0);
  }

  deleteProofs(proofs) {
    // delete proofs from this.proofs
    const usedSecrets = proofs.map((p) => p.secret);
    this.proofs = this.proofs.filter((p) => !usedSecrets.includes(p.secret));
    this.storeProofs();
    return this.proofs;
  }

  assertMintError(resp) {
    if (resp.data.hasOwnProperty("error")) {
      const e = `Mint error (code ${resp.data.code}): ${resp.data.error}`;
      throw new Error(e);
    }
  }
}

module.exports.Wallet = Wallet;
