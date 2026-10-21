// electron-builder's Windows signing hook (win.signtoolOptions.sign): signs Saturn's own executables with the
// configured certificate and leaves everyone else's alone. Third-party programs inside the package (ONNX Runtime,
// anything under the runtime's node_modules) keep their publisher's signature instead of being re-signed with
// Saturn's self-signed certificate. Saturn IDE.exe is Saturn's own and is signed.
const path = require("node:path");

function isThirdParty(file) {
  const normalized = file.split(path.sep).join("/").toLowerCase();
  return normalized.includes("/resources/runtime/node_modules/") || normalized.includes("/resources/saturn ide/resources/app/node_modules");
}

exports.default = async function sign(configuration, packager) {
  if (isThirdParty(configuration.path)) {
    console.log(`  • not re-signing a third-party program  ${path.basename(configuration.path)}`);
    return;
  }
  const manager = await packager.signingManager.value;
  await manager.doSign(configuration, packager);
};
exports.isThirdParty = isThirdParty;
