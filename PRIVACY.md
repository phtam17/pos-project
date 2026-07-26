# Public sandbox privacy note

The hosted VariPOS sandbox is designed to work without an account and without
personal information. Do not enter real card numbers, bank credentials,
customer names, addresses, phone numbers, email addresses, or production data.

The application stores a signed sandbox session token in the browser's session
storage. The server stores synthetic carts, orders, payment attempts, payments,
and receipts under a randomly generated guest scope. Automatic reset removes
transaction data on the configured schedule.

The hosting platform may retain ordinary operational metadata such as IP
address, user agent, request path, timestamp, response status, and application
errors. Application logs redact authorization headers, manager credentials,
PIN fields, and raw webhook bodies. Retention and infrastructure logging are
also governed by the selected hosting provider.

This note covers the demonstration project only. A real merchant deployment
would require its own reviewed privacy notice, retention schedule, access
controls, and legal assessment.
