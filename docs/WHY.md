# Why Slire?

It's fair to ask: "Why create another database abstraction library when so many already exist?" This question deserves a thoughtful response, especially given the abundance of ORMs (Object-Relational Mappers) and ODMs (Object-Document Mappers — we'll use ORM to refer to both throughout this section) in the Node.js ecosystem.

## The Problem with Traditional ORMs

Most existing database abstraction libraries follow the traditional ORM approach: comprehensive abstractions that aim to hide database complexity entirely while providing extensive convenience features. Popular solutions like [Mongoose](https://mongoosejs.com/), [Prisma](https://www.prisma.io/orm), [TypeORM](https://typeorm.io/), and [MikroORM](https://mikro-orm.io/) each offer rich feature sets including schema validation, relationship mapping, query builders, and code generation.

The ORM value proposition is compelling: translate complex database operations into familiar object-oriented patterns while providing developer-friendly conveniences like type safety, schema validation, and query builders. The goal is to make data access concerns blend seamlessly with application code.

However, this approach introduces several fundamental challenges:

- **Impedance mismatch**: Structural and conceptual differences between relational/document databases and object-oriented programming models create ongoing friction.
- **Feature coverage gaps**: Not every database feature is supported, forcing compromises that are often overlooked by developers without deep database knowledge.
- **Performance bottlenecks**: The N+1 problem, inefficient query generation, and excessive roundtrips frequently require bypassing the ORM for performance-critical operations.
- **Additional complexity**: Another abstraction layer to learn and debug, especially problematic when native database features are eventually needed anyway.

These challenges are well-documented in the development community. Ted Neward famously called the ["Object-Relational Impedance Mismatch"](https://blog.codinghorror.com/object-relational-mapping-is-the-vietnam-of-computer-science/) the "Vietnam War of Computer Science" (original article [here](https://www.odbms.org/wp-content/uploads/2013/11/031.01-Neward-The-Vietnam-of-Computer-Science-June-2006.pdf)). The [N+1 query problem](https://stackoverflow.com/questions/97197/what-is-the-n1-selects-problem-in-orm-object-relational-mapping) remains a persistent issue across major ORMs, and mainstream tools either explicitly document raw/native escape hatches for advanced use cases or point to native drivers directly. See also:
- Fowler’s perspective on trade‑offs - [“ORM Hate”](https://martinfowler.com/bliki/OrmHate.html),
- [ORMs are nice but they are the wrong abstraction](https://workdad.dev/posts/orms-are-nice-but-they-are-the-wrong-abstraction/)

While these critiques often target ORMs for relational databases, ODMs for document stores are not immune. They avoid parts of the object‑relational impedance mismatch, but still introduce an abstraction that enforces particular mental models and constraints. Many ODMs encourage strict schemas, lifecycle hooks, or query builders that can pull you away from the flexible, document‑oriented model these databases are designed for. The practical result is similar: for non‑trivial cases you reach for the native driver, while carrying the ongoing cost of the extra layer.

This raises a fundamental question: Why add another abstraction layer when native database clients and query languages are already excellent, well-designed APIs? Modern database drivers provide clean interfaces, comprehensive feature coverage, excellent documentation, and active maintenance. For experienced developers who understand their database technology, ORM abstractions often become unnecessary overhead rather than genuine value - another layer to learn, debug, and work around.

## Slire's Philosophy and Approach

Slire emerged from a fundamentally different perspective: start with native database access, then identify and solve only the repetitive patterns that naturally arise. Rather than hiding database complexity, Slire embraces it while addressing genuine pain points developers face with pure native access.

**Core principles:**

- **Native-first access**: Direct database operations are the primary interface, not an escape hatch. Slire provides helpers that enhance native access rather than replacing it.
- **Minimal, focused abstraction**: Only the most common operations (basic CRUD, simple queries) get convenience methods. Complex operations use native database features with optional consistency helpers.
- **Automatic multi-tenancy**: Built-in scoping eliminates the repetitive, error-prone task of manually adding tenant filters to every query.
- **Optional consistency**: Instead of forcing rigid schemas, Slire provides optional consistency guarantees (timestamps, versioning, soft delete, tracing) that work with native operations.

Slire follows the tradition of MicroORMs like [Dapper](https://github.com/DapperLib/Dapper), [Massive](https://github.com/robconery/massive-js/), and [PetaPoco](https://github.com/CollaboratingPlatypus/PetaPoco). These tools emerged as a response to full ORM complexity, providing just enough abstraction to eliminate boilerplate while working seamlessly alongside direct database access. Slire is exactly such a tool, focused on native‑first access and consistent managed fields (scope, timestamps, versioning, soft delete, tracing).

**What Slire deliberately avoids:**

Slire doesn't try to replace your database knowledge with abstractions. Instead of hiding MongoDB's aggregation framework behind query builders, it encourages direct usage while providing consistency helpers. It doesn't attempt database-agnostic complex operations (which either reduce functionality to the lowest common denominator or leak database-specific features anyway). And it doesn't manage schemas or relationships — document databases excel at flexible schemas and embedded data, so Slire works with this paradigm rather than forcing relational patterns.

**Bottom-up design from real patterns:**

This approach emerged organically from observing teams repeatedly writing the same basic CRUD operations, inconsistently applying timestamps and audit trails, and struggling with tightly coupled business logic. Slire codifies these proven patterns while working alongside direct database access. Some [architectural guidance](DESIGN.md) shows how to integrate tools like Slire effectively into application architecture and business logic - patterns that evolved from practical necessity, not theoretical design.
