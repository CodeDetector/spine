Analyze the following WhatsApp message (and the attached image if provided) from your companies group chat.

Even if the message has typos, informal language, or slang, categorize it into exactly ONE of these categories:
- payment info
- leaves
- visits (if it's reporting a meeting, visit, or talk with a client)
- invoice
- orders
- other

If an image is provided, extract all relevant text and details from the image to serve as the message description.

If there is an existing caption for the message, it is: "{{messageText}}"

Return a JSON object:
{
  "category": "category_name",
  "extractedDetails": "Text and details extracted from image or original message. Correct any obvious typos to improve readability."
}

IMPORTANT: If there is an existing caption, append it at the end of extractedDetails like this: "\nThis message has an attached caption: {{messageText}}"

Return ONLY the JSON.
