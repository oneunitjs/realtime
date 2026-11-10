import { e2eeReady, generateDeviceKeys, toBase64 } from "../src/e2ee/index.js";

await e2eeReady();
const keys = generateDeviceKeys();
console.log("identityPublicKey", toBase64(keys.x25519PublicKey));
console.log("signingPublicKey", toBase64(keys.ed25519PublicKey));
