import test from "node:test";import assert from "node:assert/strict";import {create_app}from"../app.js";import{InferenceService}from"../inference/service.js";import{launch_service_fixture}from"@fracto/sdk/testing/ServiceFixture.js";import{fileURLToPath}from"node:url";import{create_chat_attachment_adapter}from"@fracto/sdk/chat/Attachments.js";import{prepare_chat_messages}from"@fracto/sdk/chat/Messages.js";
const token="a".repeat(64),body={contract_version:1,messages:[{role:"user",content:"Hello"}]};
test("administrator bridge reaches AI chat generation over HTTP", async (t) => {
  let received;
  const service = new InferenceService({
    store: {
      token,
      all: () => [],
      maintain() {},
      close() {},
      free_bytes: () => 10 * 1024 ** 3,
    },
    adapter: {
      generate: async ({ messages }) => {
        received = messages;
        return { text: "Local model answer" };
      },
    },
    free_memory: () => 16 * 1024 ** 3,
    poll_ms: 60000,
  });
  const server = create_app({ inference: service }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const remote=await launch_service_fixture(fileURLToPath(new URL("../../fracto-admin-server/test/chat_fixture.mjs",import.meta.url)),{port:server.address().port,token},t);
  const f={request:(value=body)=>fetch(remote.base+"/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)})};
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    contract_version: 1,
    message: { role: "assistant", content: "Local model answer" },
  });
  assert.deepEqual(received, body.messages);
  const attachments = create_chat_attachment_adapter();
  const file = await attachments.send(
    await attachments.add({ file: new File(['{"count":7}'], "data.json") }),
  );
  const file_body = {
    contract_version: 1,
    messages: prepare_chat_messages([
      {
        role: "user",
        content: [{ type: "text", text: "What is the count?" }],
        attachments: [file],
      },
    ]),
  };
  assert.equal((await f.request(file_body)).status, 200);
  assert.ok(received[0].content.includes('"count":7'));
  assert.ok(received[0].content.includes("data.json"));
});
