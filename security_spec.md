# Security Specification & Invariants — Al Mathaq Al Yemeni Daily Inventory

## 1. Core Data Invariants
1. **No Self-Privilege Escalation**: An authenticated employee may NEVER set or modify their own `role`, `department`, `status`, or `permissions` in `/users/{uid}` or create `/admins/{uid}` unless they are the bootstrapped owner email (`mathaqinventory@gmail.com` with `email_verified == true`) or an existing verified executive admin.
2. **Department Isolation**:
   - Factory (`factory`) can create/read factory transfers and factory department reports, and create `pending_technical` products, but CANNOT read or write Sales (`sales`), Waste (`waste`), or final `productResults`.
   - Production (`production`) can confirm receipt on `factoryTransfers` (updating ONLY `receivedQty`, `varianceQty`, `productionNote`, `status`, `receivedBy`, `receivedByName`, `updatedAt`) and NEVER alter `sentQty`. Production can record independent production and perform technical approval (`pending_technical -> pending_admin` or `rejected`) on products.
   - Sales (`sales`) can create/update/submit `sales` department reports and view `productResults` only if granted permission.
   - Waste (`waste`) can create/update/submit `waste` department reports and CANNOT read other departments' reports or `productResults`.
3. **Immutability & Terminal Locking**:
   - Once a `departmentReports/{reportId}` reaches `submitted`, `approved`, or `closed`, operational staff CANNOT edit it directly; corrections require an admin-approved `ApprovalRequest`.
   - Once a `dailySessions/{sessionId}` is `closed`, NO operational writes are permitted for that session unless Top Management reopens it with a documented reason.
   - `auditLogs` are strictly append-only (no update, no delete).
4. **Temporal & Structural Integrity**:
   - All `createdAt` / `updatedAt` timestamps must match `request.time`.
   - All document IDs must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` chars.
   - All strings have explicit `.size()` bounds; no ghost fields (`keys().hasOnly(...)`).

## 2. "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Self-Admin Promotion**: Sales user attempts `setDoc('/admins/' + uid, { role: 'ceo' })`.
2. **Role Tampering on Profile Update**: Factory user attempts `updateDoc('/users/' + uid, { role: 'ceo', department: 'management' })`.
3. **Shadow Ghost Field Injection**: User injects `{ ..., isAdminOverride: true }` into `/products/{id}` or `/departmentReports/{id}`.
4. **Unverified Email Spoofing**: Token with `email: 'mathaqinventory@gmail.com'` and `email_verified: false` attempts admin write.
5. **Cross-Department Data Snoop (Factory -> Sales)**: Factory user attempts `get` or `list` on `/departmentReports` where `department == 'sales'`.
6. **Production Altering Factory Sent Qty**: Production user attempts `updateDoc('/factoryTransfers/t1/items/p1', { sentQty: 10, receivedQty: 10 })`.
7. **Post-Submission Tampering**: Sales user attempts `updateDoc('/departmentReports/r1/items/p1', { salesQty: 99 })` after `r1.status == 'submitted'`.
8. **Closed Session Write**: Production user attempts `addDoc('/productionEntries', { sessionId: 'closed_session' })`.
9. **Audit Log Deletion / Alteration**: Even an admin attempts `deleteDoc('/auditLogs/log1')` or `updateDoc('/auditLogs/log1', ...)`.
10. **PII Leak via User List**: Non-admin user attempts `list` on `/users` to scrape all employee emails and employee numbers.
11. **Client Timestamp Forgery**: User submits `createdAt: Timestamp(2020-01-01)` instead of `serverTimestamp()`.
12. **Oversized ID / Resource Poisoning**: User attempts `setDoc('/categories/' + 'a'.repeat(500), ...)` or 50KB description string.
