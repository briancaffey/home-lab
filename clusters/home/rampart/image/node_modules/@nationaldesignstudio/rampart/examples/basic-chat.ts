import { createGuard } from "../index.ts";

const guard = await createGuard();

const safe = await guard.protect("My name is Alex Rivera. My SSN is 472-81-0094.");
const reply = await llm(safe.text);

console.log(guard.reveal(reply));

async function llm(text: string): Promise<string> {
  return "Got it, [GIVEN_NAME_1].";
}