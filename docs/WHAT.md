## What the Heck is Slire?

Slire is a lightweight, database-agnostic interface that provides common CRUD operations with built-in consistency features, designed to work seamlessly alongside native database access. It currently supports MongoDB and Firestore implementations.

**Consistency features** are patterns that most applications need but typically implement inconsistently: automatic timestamps (createdAt, updatedAt), versioning for optimistic locking, soft-delete functionality, and audit trails. Rather than manually adding these to every operation, Slire applies them automatically while still allowing native database access for complex queries and operations.

Slire emerged from practical production needs moving between ODM‑style convenience and pure native database access across Firestore and MongoDB. Both approaches have pros and cons: ODMs provide convenience but limit functionality, while native access offers full power but requires repetitive boilerplate. Slire occupies a middle ground: more convenience than pure native drivers, but significantly less abstraction than traditional ORMs. It's designed for teams who understand their database technology and want to use it effectively without losing access to advanced features.

For a deeper understanding of the problems this approach solves, see [docs/WHY.md](docs/WHY.md).