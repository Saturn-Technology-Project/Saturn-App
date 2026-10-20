// Loaded before every test file (npm test): tests keep the secrets key in a file inside their temporary data folder,
// so they never write to the developer's Keychain, DPAPI or Secret Service.
process.env.SATURN_SECRET_STORE ??= "file";
