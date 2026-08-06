const apiBaseUrl = new URL(process.env.API_BASE_URL ?? "http://127.0.0.1:3000");

if (apiBaseUrl.protocol !== "http:" && apiBaseUrl.protocol !== "https:") {
  throw new Error("API_BASE_URL must use http or https.");
}

const fixtures = [
  {
    name: "hello.txt",
    type: "text/plain",
    bytes: Buffer.from("hello from the API smoke test\n", "utf8"),
  },
  {
    name: "bytes.bin",
    type: "application/octet-stream",
    bytes: Buffer.from([0x00, 0x0d, 0x0a, 0x80, 0xfe, 0xff]),
  },
];
const sharedText = "API smoke test text";

async function main() {
  const formData = new FormData();
  formData.append("expiresIn", "1h");
  formData.append("text", sharedText);
  for (const fixture of fixtures) {
    formData.append(
      "files",
      new Blob([fixture.bytes], { type: fixture.type }),
      fixture.name,
    );
  }

  const created = await requestJson(
    new URL("/api/shares", apiBaseUrl),
    { method: "POST", body: formData },
    201,
  );
  assertShare(created);
  if (
    typeof created.managementToken !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/.test(created.managementToken)
  ) {
    throw new Error("The create response did not include a management token.");
  }
  if (created.text !== sharedText || created.files.length !== fixtures.length) {
    throw new Error("The create response did not preserve all smoke fixtures.");
  }

  const retrieved = await requestJson(
    new URL(`/api/shares/${created.code}`, apiBaseUrl),
    { headers: { Accept: "application/json" } },
    200,
  );
  assertShare(retrieved);
  const { managementToken, ...publicCreated } = created;
  if (JSON.stringify(retrieved) !== JSON.stringify(publicCreated)) {
    throw new Error("The retrieved share does not match the create response.");
  }

  for (const [index, file] of retrieved.files.entries()) {
    const response = await fetch(new URL(file.downloadUrl, apiBaseUrl));
    if (!response.ok) {
      throw new Error(
        `Download for ${file.name} returned HTTP ${response.status}.`,
      );
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (!downloaded.equals(fixtures[index].bytes)) {
      throw new Error(`Downloaded bytes for ${file.name} did not match.`);
    }
    if (response.headers.get("x-content-type-options") !== "nosniff") {
      throw new Error(`Download for ${file.name} is missing nosniff.`);
    }
  }

  await requestJson(
    new URL(`/api/shares/${created.code}`, apiBaseUrl),
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${managementToken}` },
    },
    204,
  );
  const deletedResponse = await fetch(
    new URL(`/api/shares/${created.code}`, apiBaseUrl),
  );
  if (deletedResponse.status !== 404) {
    throw new Error(
      `Deleted share lookup returned HTTP ${deletedResponse.status}.`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        code: created.code,
        shareUrl: created.shareUrl,
        files: created.files.map((file) => file.name),
        expiresAt: created.expiresAt,
        deleted: true,
      },
      null,
      2,
    ),
  );
}

async function requestJson(url, init, expectedStatus) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    const apiMessage = body?.error?.message;
    throw new Error(
      `${init.method ?? "GET"} ${url.pathname} returned HTTP ${response.status}${
        typeof apiMessage === "string" ? `: ${apiMessage}` : ""
      }.`,
    );
  }
  return body;
}

function assertShare(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.code !== "string" ||
    !/^\d{6}$/.test(value.code) ||
    typeof value.shareUrl !== "string" ||
    !Array.isArray(value.files)
  ) {
    throw new Error("The API returned an invalid share response.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
