const { ethers } = require('ethers');
const { encrypt, decrypt } = require('./helpers');

function createAffiliateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKeyEncrypted: encrypt(wallet.privateKey),
  };
}

function getPrivateKey(encryptedKey) {
  try {
    return decrypt(encryptedKey);
  } catch {
    return null;
  }
}

function isValidAddress(address) {
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

module.exports = { createAffiliateWallet, getPrivateKey, isValidAddress };
