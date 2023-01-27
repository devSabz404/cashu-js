const axios = require("axios").default;
const { utils, Point } = require("@noble/secp256k1");
const dhke = require("./dhke");
const { splitAmount, bytesToNumber, bigIntStringify } = require("./utils");
const { uint8ToBase64 } = require("./base64");
const bolt11 = require("bolt11");

// local storage for node
if (typeof localStorage === "undefined" || localStorage === null) {
  var LocalStorage = require("node-localstorage").LocalStorage;
  localStorage = new LocalStorage("./scratch");
}

class Wallet {
  constructor() {
    this.proofs = JSON.parse(localStorage.getItem("proofs") || "[]");
  }

  // --------- GET /keys

  async loadMint() {
    /* Gets public keys of the mint */
    this.keys = await this.getKeysApi();
  }

  async getKeysApi() {
    const { data } = await axios.get(`${MINT_SERVER}/keys`);
    return data;
  }

  // --------- POST /mint

  /* 
  
  Mint new tokens by providing a payment hash corresponding to a paid Lightning invoice. 

  The wallet provides an array of `outputs` (aka blinded secrets) which are to be signed by the mint.
  The mint then responds with these `promises` (aka blinded signatures). 
  The wallet then unblinds these and stores them as `proofs`, which are the tuple (secret, signature). 
  
  */

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
      this.proofs = this.proofs.concat(proofs);
      this.storeProofs();
      return proofs;
    } catch (error) {
      console.log("Failed to execute 'mint' command");
      console.error(error);
    }
  }

  // --------- GET /mint

  /* Request to mint new tokens of a given amount. Mint will return a Lightning invoice that the user has to pay. */

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

  // --------- POST /split

  async splitApi(proofs, amount) {
    try {
      const total = this.sumProofs(proofs);
      const frst_amount = total - amount;
      const scnd_amount = amount;
      const frst_amounts = splitAmount(frst_amount);
      const scnd_amounts = splitAmount(scnd_amount);
      const amounts = [...frst_amounts];
      amounts.push(...scnd_amounts);
      let secrets = await this.generateSecrets(amounts);
      if (secrets.length != amounts.length) {
        throw new Error("number of secrets does not match number of outputs.");
      }
      let { outputs, rs } = await this.constructOutputs(amounts, secrets);
      const postSplitRequest = {
        amount: amount,
        proofs: proofs,
        outputs: outputs,
      };

      const postSplitResponse = await axios.post(
        `${MINT_SERVER}/split`,
        postSplitRequest
      );
      this.assertMintError(postSplitResponse);
      const frst_rs = rs.slice(0, frst_amounts.length);
      const frst_secrets = secrets.slice(0, frst_amounts.length);
      const scnd_rs = rs.slice(frst_amounts.length);
      const scnd_secrets = secrets.slice(frst_amounts.length);
      const fristProofs = this.constructProofs(
        postSplitResponse.data.fst,
        frst_secrets,
        frst_rs
      );
      const scndProofs = this.constructProofs(
        postSplitResponse.data.snd,
        scnd_secrets,
        scnd_rs
      );

      return { fristProofs, scndProofs };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async split(proofs, amount) {
    /*
        supplies proofs and requests a split from the mint of these
        proofs at a specific amount
        */
    try {
      if (proofs.length == 0) {
        throw new Error("no proofs provided.");
      }
      let { fristProofs, scndProofs } = await this.splitApi(proofs, amount);
      this.deleteProofs(proofs);
      // add new fristProofs, scndProofs to this.proofs
      this.proofs = this.proofs.concat(fristProofs).concat(scndProofs);
      this.storeProofs();
      return { fristProofs, scndProofs };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async splitToSend(proofs, amount, invlalidate = false) {
    /*
        splits proofs so the user can keep firstProofs, send scndProofs.
        then sets scndProofs as reserved.

        if invalidate, scndProofs (the one to send) are invalidated
        */
    try {
      const spendableProofs = proofs.filter((p) => !p.reserved);
      if (this.sumProofs(spendableProofs) < amount) {
        throw Error("balance too low.");
      }

      // call /split
      let { fristProofs, scndProofs } = await this.split(
        spendableProofs,
        amount
      );
      // set scndProofs in this.proofs as reserved
      const usedSecrets = proofs.map((p) => p.secret);
      for (let i = 0; i < this.proofs.length; i++) {
        if (usedSecrets.includes(this.proofs[i].secret)) {
          this.proofs[i].reserved = true;
        }
      }
      if (invlalidate) {
        // delete scndProofs from db
        this.deleteProofs(scndProofs);
      }

      return { fristProofs, scndProofs };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  async redeem(proofs) {
    /*
    Uses the /split endpoint to receive new tokens.
    */
    try {
      const amount = proofs.reduce((s, t) => (s += t.amount), 0);
      await this.split(proofs, amount);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  // --------- POST /melt

  async melt(invoice) {
    try {
      const amount_invoice = bolt11.decode(invoice).millisatoshis / 1000;
      const amount = amount_invoice + (await this.checkFees(invoice));

      let { _, scndProofs } = await this.splitToSend(this.proofs, amount);
      const postMeltRequest = {
        proofs: scndProofs.flat(),
        amount: amount,
        invoice: invoice,
      };

      const postMeltResponse = await axios.post(
        `${MINT_SERVER}/melt`,
        postMeltRequest
      );
      this.assertMintError(postMeltResponse);
      if (postMeltResponse.data.paid) {
        this.deleteProofs(scndProofs);
      }
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  // --------- GET /checkfees

  async checkFees(invoice) {
    const getCheckFeesRequest = {
      pr: invoice,
    };
    try {
      const checkFeesResponse = await axios.post(
        `${MINT_SERVER}/checkfees`,
        getCheckFeesRequest
      );
      this.assertMintError(checkFeesResponse);
      return checkFeesResponse.data.fee;
    } catch (error) {
      console.error(error);
      throw error;
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

  serializeProofs(proofs) {
    return btoa(JSON.stringify(proofs));
  }

  // local storage

  storeProofs() {
    localStorage.setItem(
      "proofs",
      JSON.stringify(this.proofs, bigIntStringify)
    );
  }

  deleteProofs(proofs) {
    // delete proofs from this.proofs
    const usedSecrets = proofs.map((p) => p.secret);
    this.proofs = this.proofs.filter((p) => !usedSecrets.includes(p.secret));
    this.storeProofs();
    return this.proofs;
  }

  // error checking from mint

  assertMintError(resp) {
    if (resp.data.hasOwnProperty("error")) {
      const e = `Mint error (code ${resp.data.code}): ${resp.data.error}`;
      throw new Error(e);
    }
  }
}

module.exports.Wallet = Wallet;
