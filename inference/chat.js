import express from "express";
import { fail } from "./contracts.js";
import { write_chat_record } from "../../../utils/chat_stream.js";

const fields = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export const chat_messages = (body) => {
  if (
    !fields(body, ["contract_version", "messages"]) ||
    body.contract_version !== 1 ||
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.length > 16 ||
    !body.messages.every(
      (message) =>
        fields(message, ["role", "content"]) &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    ) ||
    body.messages.at(-1).role !== "user" ||
    Buffer.byteLength(JSON.stringify(body.messages)) > 8192
  )
    fail("INVALID_REQUEST");
  return body.messages.map(({ role, content }) => ({ role, content }));
};

// Registered after machine authentication, before the smaller job-body parser.
export const register_chat_route = (router, service) => {
  router.post(
    "/chat",
    express.json({ limit: 16 * 1024, strict: true, inflate: false }),
    async (req, res) => {
      if (Object.keys(req.query).length) fail("INVALID_REQUEST");
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.on("aborted", disconnect);
      res.on("close", disconnect);
      try {
        const streaming = req.get("accept") === "application/x-ndjson";
        const result = await service.chat(req.body, {
          signal: controller.signal,
          ...(streaming
            ? {
                on_delta: (text, stream_signal) =>
                  write_chat_record(
                    res,
                    {
                      contract_version: 1,
                      type: "delta",
                      text,
                    },
                    stream_signal,
                  ),
              }
            : {}),
        });
        if (!res.destroyed) {
          if (streaming) {
            await write_chat_record(
              res,
              { contract_version: 1, type: "done" },
              controller.signal,
            );
            res.end();
          } else res.json(result);
        }
      } catch (error) {
        if (res.headersSent && !res.destroyed) {
          res.end(
            `${JSON.stringify({
              contract_version: 1,
              type: "error",
              error:
                error.code === "DEADLINE_EXCEEDED"
                  ? "CHAT_TIMEOUT"
                  : "CHAT_UNAVAILABLE",
            })}\n`,
          );
        } else if (!res.destroyed) throw error;
      } finally {
        req.off("aborted", disconnect);
        res.off("close", disconnect);
      }
    },
  );
};
