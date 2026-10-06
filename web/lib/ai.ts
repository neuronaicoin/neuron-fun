import { authedPost, type SignFn } from "./alerts";

export type AiIdea = { name: string; symbol: string; description: string; art: string };

/** Three coin ideas (name, ticker, story, picture brief) from one sentence. */
export async function aiIdeas(sign: SignFn, idea: string): Promise<AiIdea[]> {
  const j = await authedPost<{ ideas: AiIdea[] }>(sign, "ai/ideas", { idea });
  return j.ideas ?? [];
}

/** A logo for one idea, as a data URL (JPEG). */
export async function aiLogo(sign: SignFn, art: string): Promise<string> {
  const j = await authedPost<{ image: string }>(sign, "ai/logo", { art });
  if (!j.image || !j.image.startsWith("data:image/")) throw new Error("Couldn't draw a picture right now.");
  return j.image;
}

export const IDEA_SPARKS: readonly (readonly [string, string])[] = [
  ["Frog trader", "A frog that trades on Robinhood"],
  ["Panda astronaut", "A sleepy panda astronaut"],
  ["Moon pizza", "Pizza that goes to the moon"],
  ["Surfing cat", "A cat that surfs the ocean waves"],
  ["King shiba", "A shiba inu wearing a crown"],
  ["Meme robot", "A robot that only eats memes"],
  ["Pirate duck", "A pirate duck looking for treasure"],
  ["DJ penguin", "A penguin DJ at an ice party"],
  ["Gold dragon", "A dragon made of gold coins"],
  ["Wall St. hamster", "A hamster running the stock market"],
  ["Candle ghost", "A ghost that loves green candles"],
  ["Rocket banana", "A banana on a rocket"],
  ["Diamond sloth", "A lazy sloth that never sells"],
  ["8-wallet octopus", "An octopus with eight wallets"],
  ["Cowboy dog", "A cowboy dog in the desert"],
  ["Night owl coffee", "A coffee cup that never sleeps"],
];
