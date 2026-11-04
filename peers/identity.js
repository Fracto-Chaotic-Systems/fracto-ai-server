import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  webcrypto,
} from "node:crypto";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { uuid } from "../inference/contracts.js";
import { read_json, reject, secure_directory, write_json } from "./files.js";

export const fields = (value, keys) => {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    reject();
};
export const certificate_info = (
  pem,
  node_id,
  now = Date.now(),
  allow_expired = false,
) => {
  if (
    !uuid(node_id) ||
    typeof pem !== "string" ||
    pem.length > 8192 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
      pem,
    )
  )
    reject();
  const certificate = new X509Certificate(pem);
  const before = Date.parse(certificate.validFrom);
  const after = Date.parse(certificate.validTo);
  const usage = [...(certificate.keyUsage || [])].sort();
  if (
    certificate.subject !== `CN=fracto-node-${node_id}` ||
    certificate.issuer !== certificate.subject ||
    certificate.ca ||
    certificate.subjectAltName !== `URI:urn:fracto:node:${node_id}` ||
    certificate.publicKey.asymmetricKeyType !== "ec" ||
    certificate.publicKey.asymmetricKeyDetails.namedCurve !== "prime256v1" ||
    !certificate.verify(certificate.publicKey) ||
    before > now ||
    (!allow_expired && after <= now) ||
    after - before > 367 * 86400000 ||
    JSON.stringify(usage) !==
      JSON.stringify(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"])
  )
    reject();
  return {
    fingerprint: certificate.fingerprint256,
    expires_at: after,
    certificate,
  };
};
export const generate_identity = async (
  node_id = randomUUID(),
  now = Date.now(),
) => {
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomBytes(16).toString("hex"),
      name: `CN=fracto-node-${node_id}`,
      notBefore: new Date(now - 300000),
      notAfter: new Date(now + 365 * 86400000),
      signingAlgorithm: algorithm,
      keys,
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(
          ["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"],
          true,
        ),
        new SubjectAlternativeNameExtension([
          { type: "url", value: `urn:fracto:node:${node_id}` },
        ]),
      ],
    },
    webcrypto,
  );
  const bytes = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  return {
    contract_version: 1,
    node_id,
    certificate: certificate.toString("pem"),
    private_key: createPrivateKey({ key: bytes, format: "der", type: "pkcs8" })
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
};
export const validate_identity = (value, { allow_expired = false } = {}) => {
  fields(value, ["contract_version", "node_id", "certificate", "private_key"]);
  if (
    value.contract_version !== 1 ||
    typeof value.private_key !== "string" ||
    value.private_key.length > 8192
  )
    reject();
  const info = certificate_info(
    value.certificate,
    value.node_id,
    Date.now(),
    allow_expired,
  );
  const key = createPublicKey(createPrivateKey(value.private_key)).export({
    format: "der",
    type: "spki",
  });
  if (
    !key.equals(
      info.certificate.publicKey.export({ format: "der", type: "spki" }),
    )
  )
    reject();
  return value;
};
export const public_identity = (value) => ({
  contract_version: 1,
  node_id: value.node_id,
  certificate: value.certificate,
});
export const load_identity = async (directory, options = {}) => {
  secure_directory(directory);
  const filename = path.join(directory, "identity.json");
  if (!fs.existsSync(filename)) {
    const identity = await generate_identity();
    try {
      write_json(filename, identity, { initial: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const identity = validate_identity(read_json(filename, 32768), options);
  write_json(
    path.join(directory, "enrollment.json"),
    public_identity(identity),
  );
  return identity;
};
