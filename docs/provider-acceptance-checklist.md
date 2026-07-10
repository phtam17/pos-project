# Provider and terminal acceptance checklist

Do not treat a general “EMV”, “contactless”, or “Discover enabled” statement as proof of the required acceptance paths. Obtain evidence for the exact country, merchant account, device, firmware, terminal application, and processor host.

## Acceptance matrix

Require a written yes/no entry and a production test for every cell:

| Brand | Insert | Tap | PIN/CVM | Refund | Provider evidence |
|---|---|---|---|---|---|
| Visa | | | | | |
| Mastercard | | | | | |
| American Express | | | | | |
| JCB | | | | | |
| UnionPay / QuickPass | | | | | |

For U.S. deployments, confirm the relevant Discover Global Network alliance BIN ranges and routing rather than assuming Discover acceptance covers every JCB or UnionPay card.

## Certification and security evidence

- PCI PTS approval number, exact firmware, SRED status, and expiry.
- PCI-listed P2PE solution reference containing the exact device and payment application.
- Active EMV contact L1/L2 and contactless L1/kernel approvals.
- Processor/acquirer L3 confirmation for each promised brand and mode.
- Responsibility matrix for terminal management, remote updates, key injection, device inspections, incident response, and annual PCI evidence.
- Documentation showing that the POS receives only tokens/references and masked receipt metadata.

## Complete fee schedule

- interchange, assessments, processor basis points, and per-item fees;
- international and cross-border uplift;
- PIN-debit network and routing fees;
- authorization, gateway, batch, monthly minimum, and PCI fees;
- refund, dispute, retrieval, chargeback, and representment fees;
- terminal purchase/lease, cellular, replacement, and early-termination costs;
- reserve, funding delay, settlement timing, and contract price-increase clauses.

Measure effective cost as all payment-related fees divided by settled card volume. Reconcile it from actual settlement and payout data rather than relying on the advertised headline rate.
