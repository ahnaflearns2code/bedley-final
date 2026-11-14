const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifty: 50, twenty: 20, thirty: 30, forty: 40, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "$250", "250 dollars", "two hundred fifty" → cents */
export function parseAmount(text: string): number | null {
  const m = text.replace(/,/g, "").match(/\$?\s?(\d{2,5}(?:\.\d{1,2})?)\s*(?:dollars|bucks|\$)?/i);
  if (m) return Math.round(parseFloat(m[1]) * 100);
  const w = text.toLowerCase().match(/(one|two|three|four|five|six|seven|eight|nine)\s+hundred(?:\s+and)?(?:\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?/);
  if (w) return (WORDS[w[1]] * 100 + (w[2] ? WORDS[w[2]] : 0)) * 100;
  return null;
}

