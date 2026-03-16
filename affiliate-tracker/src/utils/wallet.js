const { ethers } = require('ethers');
const { encrypt, decrypt } = require('./helpers');

// Generate a new Ethereum wallet
function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase || null
  };
}

// Create wallet and return encrypted private key for storage
function createAffiliateWallet() {
  const wallet = generateWallet();
  return {
    address: wallet.address,
    privateKeyEncrypted: encrypt(wallet.privateKey)
  };
}

// Retrieve private key (only use when absolutely necessary, e.g., for admin export)
function getPrivateKey(encryptedKey) {
  try {
    return decrypt(encryptedKey);
  } catch (error) {
    console.error('Failed to decrypt private key:', error);
    return null;
  }
}

// Validate an Ethereum address
function isValidAddress(address) {
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

module.exports = {
  generateWallet,
  createAffiliateWallet,
  getPrivateKey,
  isValidAddress
};
