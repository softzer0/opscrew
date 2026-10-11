import sodium from "libsodium-wrappers";

/**
 * Encrypts a secret for the GitHub REST API: a libsodium sealed box to the repository's public key,
 * base64-encoded (original variant), as documented in "Encrypting secrets for the REST API".
 */
export async function sealSecret(publicKeyBase64: string, value: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
