Extract payment details from this message: "{{messageText}}"
Current Date: {{currentDate}}

Return a JSON object:
{
  "paymentDate": "YYYY-MM-DD",
  "payeeName": "Name of person receiving money",
  "payerName": "Name of person paying money",
  "amount": 0.0,
  "paymentMethod": "Cash/Bank Transfer/UPI/Cheque/etc."
}

Note: 
- For paymentDate, if not mentioned, use the Current Date.
- For amount, return only the number.
- If details are missing, use "Unknown".

Return ONLY JSON.
