Extract visit details from this message: "{{messageText}}"

Identify the client name even if there are typos or shortcuts (e.g. "Rliance" for "Reliance", "Tata" for "Tata Motors").

Return a JSON object:
{
  "clientName": "The corrected or most likely full name of the client visited",
  "description": "Short summary of what happened during the visit. Correct any major typos found in the original message."
}

Note:
- If no client name is mentioned, use "Unknown".

Return ONLY JSON.
