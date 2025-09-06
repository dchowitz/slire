# SmartRepo README Style Guide

This document captures the style decisions and voice guidelines for maintaining consistency in the SmartRepo README.

## Document Structure & Voice

The README has two distinct parts that require different approaches:

### Part 1: SmartRepo Library Documentation

**Sections**: "What the Heck is SmartRepo?" through "Recommended Usage Patterns"
**Nature**: API reference, implementation guide, specific tool usage
**Reader goal**: "How do I use this library?"
**Voice**: Direct instructional using "you"

Examples:

- ✅ "You create a repository by calling `createSmartMongoRepo`..."
- ✅ "You can access the MongoDB collection using `repo.collection`"
- ✅ "You should export repository types to enable..."

### Part 2: General Architectural Guidance

**Sections**: "Decoupling Business Logic from Data Access" onward
**Nature**: Design principles, architectural patterns, software engineering advice  
**Reader goal**: "What are good practices for organizing data access?"
**Voice**: Mix of neutral guide voice and advisory "you" - avoid collaborative "we"

Examples:

- ✅ "This section presents principles..." (neutral)
- ✅ "Consider these approaches when..." (neutral advisory)
- ✅ "You can organize factories..." (direct advisory)
- ❌ "We examine approaches that..." (collaborative we)
- ❌ "When we design data access layers..." (collaborative we)

Convert collaborative "we" to:

- "we use 'data access' to mean..." → "this guide uses 'data access' to mean..."
- "we discussed earlier" → "discussed in the previous section"
- "Here's how we can structure..." → "Here's how to structure..." or "Consider structuring..."

## Formatting Preferences

### Bold Text Usage

- Minimize bold formatting to reduce "screaming"
- Use bold sparingly for emphasis, not for every key term
- Prefer structure (headings, lists) over bold for organization

### Lists and Bullets

- Use simple minus dashes (-) for lists instead of colons or fancy formatting
- Lowercase words at beginning of bullet points when they are not complete sentences
- Keep list items concise and parallel in structure

### Table of Contents

- Show all headings up to level 3 in the TOC (##, ###, but not ####)
- Group related functions on single lines in the TOC separated by dashes
- Example: `[getById](#getbyid) - [getByIds](#getbyids)` instead of separate bullet points
- Maintains all navigation links while reducing visual clutter
- Apply to API reference sections with many similar function pairs

### General Style

- Clean, simple explanations without excessive formatting
- Avoid overly enthusiastic language
- Prefer straightforward, professional tone

## Terminology Conventions

### "Data Access" Scope

- "Data access" specifically means database operations throughout this guide
- Acknowledge that patterns transfer to external APIs, file systems, caching layers, etc.
- Suggest readers could use `DbAccess` instead of `DataAccess` types for clarity
- External services should be organized into separate "service access" modules

### Cross-References

- Link back to relevant sections when referencing concepts discussed earlier
- Use descriptive link text: `[repository type section](#export-repository-types)`

## Content Organization

### Section Headings

- Use sentence case for headings
- Make headings descriptive and scannable
- Consider the reader's mental model progression

### Code Examples

- Keep examples focused and not overly complex
- Use ellipsis (...) to shorten examples when full implementation would distract
- Maintain consistent naming conventions across examples

## Voice Transition Example

When moving from Part 1 to Part 2, the voice should shift from:

**Part 1 style**: "You create repositories using the factory pattern..."

**Part 2 style**: "The factory pattern provides several organizational benefits. Consider these approaches when designing your data access architecture. You can choose the approach that best fits your team structure and application complexity."

This creates a natural transition from tool-specific instructions to broader architectural guidance.
