import { describe, expect, it } from "vitest";
import { RetellClient } from "../src";

const clientWith = (body: unknown, status = 200) =>
  new RetellClient({ apiKey: "k", baseUrl: "https://retell.test", fetch: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch });

describe("RetellClient.listVoices", () => {
  it("normaliza las voces y descarta las que no traen identificador", async () => {
    const voices = await clientWith([
      { voice_id: "11labs-Ana", voice_name: "Ana", provider: "elevenlabs", gender: "female", accent: "Mexican", preview_audio_url: "https://x/a.mp3" },
      { voice_id: "openai-Echo" },
      { voice_name: "sin id" },
      null,
    ]).listVoices();
    expect(voices).toEqual([
      { id: "11labs-Ana", name: "Ana", provider: "elevenlabs", gender: "female", accent: "Mexican", age: undefined, previewUrl: "https://x/a.mp3" },
      { id: "openai-Echo", name: "openai-Echo", provider: undefined, gender: undefined, accent: undefined, age: undefined, previewUrl: undefined },
    ]);
  });

  it("devuelve lista vacia si Retell responde algo que no es una lista", async () => {
    expect(await clientWith({ voices: [] }).listVoices()).toEqual([]);
  });

  it("propaga el error de Retell", async () => {
    await expect(clientWith({ message: "clave invalida" }, 401).listVoices()).rejects.toMatchObject({ status: 401 });
  });
});
