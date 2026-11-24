# Librarium Firestore Security Specification

## 1. Data Invariants
1. All user data resides strictly under `/users/{userId}` and is readable/writable ONLY when `request.auth != null`, `request.auth.token.email_verified == true` (for writes/reads of private library data), and `request.auth.uid == userId`.
2. Every document ID (`userId`, `bookId`, `noteId`, `entryId`, `quoteId`, `analysisId`, `convId`, `mediaId`) must match `^[a-zA-Z0-9_\-]+$` and be at most 128 characters.
3. Every subcollection document must include `userId == request.auth.uid` (and `userId == userId` path variable), immutable `id`, `userId`, and `createdAt`.
4. `notes`, `entries`, `quotes`, `analyses`, and `conversations` must reference an existing parent book under `/users/{userId}/books/{bookId}` on `create`, and `bookId` is immutable on `update`.
5. `createdAt` must equal `request.time` on `create`, and `updatedAt` must equal `request.time` on both `create` and `update` (except `media` which is immutable after creation).
6. Array fields are strictly bounded: `book.tags.size() <= 10`, `quote.photoMediaIds.size() <= 5`, `analysis.themes.size() <= 12`, `analysis.connections.size() <= 20`, `analysis.questions.size() <= 10`, `conversation.history.size() <= 40`.
7. Media payloads (`media.dataUrl`) are bounded to `750000` characters to stay safely below the 1MB Firestore document limit.
8. Strict key allowlisting via `keys().hasAll(...) && keys().hasOnly(...)` on `create` and `diff().affectedKeys().hasOnly(...)` on `update` prevents shadow fields.
9. Community reports & feature suggestions reside under `/feedback/{feedbackId}`: any verified signed-in user (`request.auth.token.email_verified == true`) can `create` a report with `userId == request.auth.uid`, initial `status == 'open'`, empty `adminNote == ''`, and `createdAt == request.time`; users may read (`get`/`list`) only their own reports (`resource.data.userId == request.auth.uid`). Only the verified admin (`[redacted]`) can read all reports, update `status`/`adminNote`, or delete reports.
10. `/users/{userId}` stores account login metadata (`displayName`, `email`, `createdAt`, `lastActiveAt`) and a strictly non-private bounded reading summary (`booksCount`, `bookSummaries` <= 100 items with title/status/pages/percent only — zero comments, notes, quotes, reviews, or media). Only the owner or verified admin (`isAdmin()`) may `get` a `/users/{userId}` document, and only `isAdmin()` may `list /users`. Private subcollections (`/books`, `/notes`, `/entries`, `/quotes`, `/analyses`, `/conversations`, `/media`) remain strictly owner-only.

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read/write**: `GET /users/alice/books/b1` or `CREATE /feedback/f1` with `auth = null`.
2. **Cross-user access**: `GET /users/alice/books/b1`, `GET /users/alice`, `LIST /users`, or `GET /feedback/f_alice` with `auth = { uid: "bob", token: { email_verified: true } }`.
3. **Unverified email write**: `CREATE /users/alice/books/b1` or `CREATE /feedback/f1` with `auth = { uid: "alice", token: { email_verified: false } }`.
4. **Identity spoofing**: `CREATE /users/alice/books/b1` or `CREATE /feedback/f1` with `userId: "bob"` while signed in as `alice`.
5. **Shadow / Ghost field**: `CREATE /users/alice/books/b1` with extra field `isAdmin: true`.
6. **ID Poisoning**: `CREATE /users/alice/books/bad:id/extra` or 200-char ID.
7. **Orphaned sub-record**: `CREATE /users/alice/quotes/q1` referencing non-existent `bookId: "missing_book"`.
8. **Client timestamp forgery**: `CREATE /users/alice/books/b1`, `UPDATE /users/alice` (`lastActiveAt`), or `CREATE /feedback/f1` with forged timestamp instead of `request.time`.
9. **Immutable field tampering**: `UPDATE /users/alice/books/b1` attempting to modify `createdAt` or `userId`, or non-admin `UPDATE /feedback/f1` attempting to forge `status: "resolved"`.
10. **Unbounded array / DoW**: `CREATE /users/alice/books/b1` with 15 `tags`, `quotes/q1` with 6 `photoMediaIds`, or `users/alice` with 101 `bookSummaries`.
11. **Oversized string / DoW**: `CREATE /users/alice/media/m1` with `dataUrl` exceeding 750,000 bytes, or `feedback.message` > 2000 chars.
12. **Invalid rating / status value**: `UPDATE /users/alice/books/b1` with `rating: 99` or `status: "hacked"`.


