# YKCircle Ticket Purchase, Cancellation & Refund Policy

> **Draft for legal review before paid-ticket launch.**  
> Last updated: 7 September 2026

This Policy describes YKCircle's intended ticket-payment model and the responsibilities shown to attendees.

## 1. Identify the seller before payment

Before a paid ticket purchase, YKCircle must clearly show:

- Event;
- organizer;
- legal ticket seller;
- whether seller declares itself a trader/business or private seller;
- ticket quantity/type;
- ticket price;
- any mandatory fees;
- applicable taxes;
- total price;
- refund/cancellation policy;
- YKCircle's role.

Do not describe YKCircle as the ticket seller unless it actually is the seller.

## 2. Ticket seller

The ticket seller is the seller Billing Profile selected by the Event organizer.

The organizer who manages the Event and the legal ticket seller may be the same person/entity, but the system must not assume this automatically.

## 3. Private sellers

If the seller declares that it is not acting as a trader/business, YKCircle may inform the attendee that consumer-protection laws governing trader-to-consumer contracts may not apply in the same way.

The seller must not falsely claim private status.

## 4. Payment-provider checkout

Where integrated ticket payments are enabled, payment is handled by [PAYMENT PROVIDER].

Under the intended direct-charge model:

- the payment is created on the seller's connected Payment Account;
- gross ticket proceeds are not collected into YKCircle for later organizer payout;
- payment-provider payout occurs to the seller;
- refunds/disputes are handled on the connected account according to provider configuration.

## 5. YKCircle's role

YKCircle may provide Event discovery, checkout integration, order records, ticket/QR delivery, payment-status synchronization, refund/dispute-state synchronization, customer-support routing and fraud/safety controls.

YKCircle does not become the ticket seller merely by providing these tools.

## 6. Payment status

Possible normalized states may include:

```text
pending
paid
failed
partially_refunded
refunded
disputed
cancelled
```

Only verified provider events should be treated as authoritative for integrated payments.

## 7. Order confirmation

After payment, the attendee should receive a durable confirmation containing:

- order reference;
- Event;
- date/time/timezone;
- seller;
- ticket type/quantity;
- total paid;
- payment status;
- refund/cancellation policy applying at purchase;
- ticket/QR code or access instructions.

The applicable seller and refund policy should be snapshotted for historical orders.

## 8. Event cancellation

If an Event is cancelled, the seller/organizer must comply with applicable law and the contract.

The organizer should mark the Event cancelled, stop ticket sales, notify attendees and process required refunds.

YKCircle may provide technical assistance and update ticket validity/status.

## 9. Material changes

Material changes may include date, time, location, programme or major access restrictions.

The seller must communicate material changes promptly.

Applicable cancellation/refund rights may arise depending on circumstances and law.

## 10. Attendee cancellation

The seller's cancellation/refund policy must be shown before purchase.

Policies may include refund until a stated deadline, partial refund, transfer or no voluntary refund, but always subject to mandatory rights.

## 11. Right of withdrawal

Do not use a universal statement that every ticket has a 14-day right of withdrawal.

Do not use a universal statement that every ticket is non-refundable.

Under Swedish consumer rules, contracts for cultural events, sporting events and similar leisure activities supplied on a specific date or period can be excluded from the ordinary withdrawal right.

The precise legal treatment must match the Event/service actually sold and seller status.

## 12. Refunds

Where the organizer is the seller and direct charges are used, the organizer initiates attendee refunds through its connected payment provider.

YKCircle should not maintain an organizer-refund wallet or payout-reversal system for this model.

YKCircle may update payment, order and ticket status after provider confirmation.

## 13. Ticket validity after refund

A fully refunded ticket should normally become invalid.

A partial refund must be represented accurately and must not automatically imply full ticket cancellation unless the product rule says so.

## 14. Disputes/chargebacks

Disputes are separate from voluntary refunds.

The connected seller is responsible for dispute handling according to payment-provider rules and the actual account configuration.

YKCircle may restrict Event/payment functionality where necessary to protect users or comply with provider/legal requirements.

## 15. Ticket fees

For the current intended architecture, YKCircle does not charge an attendee-facing per-ticket application fee.

If this changes, update checkout, Organizer Terms, this Policy, refund treatment and accounting/tax logic.

## 16. YKCircle subscriptions/event fees are separate

A refund of an organizer's attendee ticket does not automatically refund:

- the organizer's YKCircle subscription;
- a YKCircle Event publishing/service fee;
- a Venue invoice.

Those are separate transactions with separate sellers/contracts.

## 17. Support

Ticket support: [TICKET SUPPORT EMAIL / URL]  
Seller contact should also be available from the Event/order where required.
