## User

import { DatabaseConnection } from "../db/database.js";
import { createPartialZodSchema } from "../../utils/schemaValidator.js";
import { logger } from "../../utils/logger.js";
import { RETRYABLE_ERRORS } from "../../constants/Prisma.errors.js";
import { Prisma } from "@prisma/client";

type TransactionFn<T = any> = (tx: Prisma.TransactionClient) => Promise<T>;
type TransactionOptions = {
maxRetries?: number;
timeoutMs?: number;
isolationLevel?: Prisma.TransactionIsolationLevel;
};

type QueryWhitelist = {
rawQueryEnabled: boolean;
tables: string[];
columns: Record<string, string[] | "\*">;
allowedOperations?: string[]; // SELECT, INSERT, UPDATE, DELETE
};

// Relation metadata type
type RelationMetadata = {
model: typeof BaseModel;
relationType: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
};

export class BaseModel {
static modelName: string | null = null;
static relationFields: string[] = [];
static zodSchema: any = null;
static fileFields: string[] = [];
static queryWhitelist: QueryWhitelist = {
rawQueryEnabled: false, // Disabled by default
tables: [],
columns: {},
allowedOperations: ["SELECT"], // Default to read-only
};

// Relation metadata for nested validation
static relationMetadata: Record<string, RelationMetadata> = {};

static get prisma() {
return DatabaseConnection.getClient();
}

static getZodSchema() {
if (!this.zodSchema) {
throw new Error("zodSchema must be defined in child class");
}
return this.zodSchema;
}

static getPartialZodSchema() {
if (!this.zodSchema) {
throw new Error("zodSchema must be defined in child class");
}
return createPartialZodSchema(this.zodSchema);
}

/\*\*

- Get related model for nested validation
  \*/
  static getRelationModel(relationField: string): typeof BaseModel | undefined {
  return this.relationMetadata[relationField]?.model;
  }

/\*\*

- Enhanced SQL Injection-Safe Raw Query with Better Validation
  \*/
  static async queryRaw(query: string, values: any[] = []): Promise<any[]> {
  if (!this.queryWhitelist.rawQueryEnabled) {
  throw new Error("Raw queries are not enabled for this model");
  }

  if (typeof query !== "string" || query.trim() === "") {
  throw new Error("Query must be a non-empty string");
  }

  if (!Array.isArray(values)) {
  throw new Error("Values must be an array");
  }

  // Basic SQL operation validation
  const queryLower = query.toLowerCase().trim();
  const operation = queryLower.split(/\s+/)[0];

  if (
  !this.queryWhitelist.allowedOperations?.includes(operation.toUpperCase())
  ) {
  throw new Error(`Disallowed SQL operation: ${operation}`);
  }

  // For SELECT queries, validate tables and columns
  if (operation === "select") {
  await this.validateSelectQuery(queryLower);
  }

  logger.info(`[${this.modelName}] Raw query`, {
  query: queryLower,
  operation,
  });

  try {
  return await this.prisma.$queryRaw(Prisma.sql([query], values));
    } catch (error: any) {
      logger.error(`[${this.modelName}] Raw query failed`, {
  error: error.message,
  query: queryLower,
  });
  throw new Error("Database query failed");
  }

}

/\*\*

- Validate SELECT query structure
  _/
  private static async validateSelectQuery(query: string): Promise<void> {
  // Extract tables from FROM and JOIN clauses
  const tableMatches = [
  ...query.matchAll(/from\s+([a-z\_]a-z0-9_]_)/gi),
  ...query.matchAll(/join\s+([a-z\_]a-z0-9_]\*)/gi),
  ];

  const tables = tableMatches.map((match) => match[1]);

  for (const table of tables) {
  if (!this.queryWhitelist.tables.includes(table)) {
  throw new Error(`Disallowed table: ${table}`);
  }
  }

  // Validate columns for each allowed table
  for (const table of this.queryWhitelist.tables) {
  const allowedColumns = this.queryWhitelist.columns[table];
  if (allowedColumns === "\*") continue;

      // Simple column validation - look for table.column patterns
      const columnPattern = new RegExp(
        `\\b${table}\\.([a-z_][a-z0-9_]*)\\b`,
        "gi"
      );
      const columnMatches = query.matchAll(columnPattern);

      for (const match of columnMatches) {
        const column = match[1];
        if (!allowedColumns.includes(column)) {
          throw new Error(`Disallowed column for table ${table}: ${column}`);
        }
      }

  }

}

/\*\*

- Safe Transaction with Retries and Better Error Handling
  \*/
  static async runInTransaction<T>(
  fn: TransactionFn<T>,
  options: TransactionOptions = {}
  ): Promise<T> {
  if (typeof fn !== "function") {
  throw new Error("Transaction callback must be a function");
  }

  const {
  maxRetries = 3,
  timeoutMs = 5000,
  isolationLevel = "ReadCommitted", // More conservative default
  } = options;

  let lastError: Error | null = null;

  for (let retry = 0; retry < maxRetries; retry++) {
  try {
  return await this.prisma.$transaction(
  async (tx: Prisma.TransactionClient) => {
  // Create a timeout promise
  const timeoutPromise = new Promise<never>((\_, reject) =>
  setTimeout(
  () =>
  reject(new Error(`Transaction timeout after ${timeoutMs}ms`)),
  timeoutMs
  )
  );

            // Race between transaction and timeout
            const result = await Promise.race([fn(tx), timeoutPromise]);
            return result;
          },
          {
            isolationLevel,
            maxWait: timeoutMs,
            timeout: timeoutMs,
          }
        );
      } catch (error: any) {
        lastError = error;

        if (
          !RETRYABLE_ERRORS.includes(error.code) ||
          retry === maxRetries - 1
        ) {
          break;
        }

        const backoffMs = 100 * Math.pow(2, retry);
        logger.warn(`[${this.modelName}] Transaction retry ${retry + 1}`, {
          error: error.message,
          backoffMs,
        });

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

  }

  logger.error(
  `[${this.modelName}] Transaction failed after ${maxRetries} retries`,
  {
  error: lastError?.message,
  }
  );

  throw lastError || new Error("Transaction failed");

}

/\*\*

- Helper method for nested validation (to be used with BaseController)
  \*/
  static async validateNestedData(
  data: any,
  isUpdate: boolean = false,
  relationField?: string
  ): Promise<any> {
  const schema = isUpdate ? this.getPartialZodSchema() : this.getZodSchema();

  if (relationField) {
  const relatedModel = this.getRelationModel(relationField);
  if (relatedModel) {
  // Recursive validation for nested relations
  return await relatedModel.validateNestedData(data, isUpdate);
  }
  }

  // Use your existing validation utility
  const validateWithZod = await import("../../utils/validation.js").then(
  (m) => m.validateWithZod
  );
  return validateWithZod(schema, data);

}
}

how will a model created from it without any extra extention

## Assistant

Looking at this `BaseModel` class, here's how a model would be created without any extra extension:

```typescript
// Example User model extending BaseModel
import { BaseModel } from "./BaseModel.js";
import { z } from "zod";

export class User extends BaseModel {
  static modelName = "User";
  static relationFields: string[] = ["posts", "profile"];
  static fileFields: string[] = ["avatar"];

  static zodSchema = z.object({
    id: z.string().uuid().optional(),
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(0).optional(),
    avatar: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  });

  static queryWhitelist = {
    rawQueryEnabled: true,
    tables: ["users", "posts"],
    columns: {
      users: ["id", "email", "name", "age", "avatar"],
      posts: ["id", "title", "content", "author_id"],
    },
    allowedOperations: ["SELECT", "UPDATE"],
  };

  static relationMetadata = {
    posts: {
      model: Post, // Assuming Post model exists
      relationType: "oneToMany",
    },
    profile: {
      model: Profile, // Assuming Profile model exists
      relationType: "oneToOne",
    },
  };
}

// Usage examples:
async function exampleUsage() {
  // 1. Basic CRUD operations (inherited from Prisma)
  const users = await User.prisma.user.findMany();

  // 2. Raw query with validation
  const results = await User.queryRaw(
    "SELECT id, email FROM users WHERE age > ?",
    [18]
  );

  // 3. Transaction with retries
  await User.runInTransaction(async (tx) => {
    await tx.user.create({ data: { email: "test@example.com", name: "Test" } });
    // More operations...
  });

  // 4. Validation
  const validatedData = await User.validateNestedData({
    email: "user@example.com",
    name: "John Doe",
  });
}
```

## Key Features Available Without Extension:

1. **Prisma Client Access**: `User.prisma` gives direct access to Prisma client methods
2. **Schema Validation**: Built-in Zod schema validation with `getZodSchema()` and `getPartialZodSchema()`
3. **Raw Query Protection**: Whitelist-based SQL injection protection
4. **Transaction Management**: Retry logic with timeout and isolation level control
5. **Nested Validation**: Recursive validation for related models
6. **Logging**: Integrated logging for queries and transactions
7. **Error Handling**: Built-in retry for retryable database errors

## Required Implementation:

The child class must define:

- `modelName`: String identifier
- `zodSchema`: Zod validation schema
- `relationFields`: Array of relation field names
- `fileFields`: Array of file-related field names
- `queryWhitelist`: Raw query permissions configuration
- `relationMetadata`: Relation model mappings

The model inherits all Prisma client methods through the static `prisma` property, making it fully functional for database operations while adding the security and validation layers provided by the base class.

## User

wont Post and Profile be imorted?

## Assistant

You're absolutely right! I made an error in my example. The `Post` and `Profile` models would need to be imported to avoid circular dependencies and reference errors. Here's the corrected version:

```typescript
// Example User model extending BaseModel
import { BaseModel } from "./BaseModel.js";
import { z } from "zod";
import { Post } from "./Post.js"; // Must import related models
import { Profile } from "./Profile.js"; // Must import related models

export class User extends BaseModel {
  static modelName = "User";
  static relationFields: string[] = ["posts", "profile"];
  static fileFields: string[] = ["avatar"];

  static zodSchema = z.object({
    id: z.string().uuid().optional(),
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(0).optional(),
    avatar: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  });

  static queryWhitelist = {
    rawQueryEnabled: true,
    tables: ["users", "posts"],
    columns: {
      users: ["id", "email", "name", "age", "avatar"],
      posts: ["id", "title", "content", "author_id"],
    },
    allowedOperations: ["SELECT", "UPDATE"],
  };

  static relationMetadata = {
    posts: {
      model: Post, // Now properly imported
      relationType: "oneToMany",
    },
    profile: {
      model: Profile, // Now properly imported
      relationType: "oneToOne",
    },
  };
}
```

## Important Considerations:

1. **Circular Dependencies**: If `Post` also references `User`, you'll need to handle circular dependencies carefully, possibly using:

   ```typescript
   // In Post.js
   static relationMetadata = {
     author: {
       model: () => import("./User.js").then(m => m.User),
       relationType: "manyToOne"
     }
   };
   ```

2. **Alternative Approach**: You could use string-based references and lazy loading:

   ```typescript
   static relationMetadata = {
     posts: {
       model: "Post" as any, // Reference by name, load dynamically when needed
       relationType: "oneToMany"
     }
   };
   ```

3. **BaseModel Modification**: The `getRelationModel` method might need to be enhanced to handle dynamic imports if you go with string references.

The original `BaseModel.getRelationModel` method assumes the model is already imported and available, so proper imports are necessary for the current implementation.

## User

why no Post and Profile in zod schema here?

## Assistant

Excellent question! The reason `Post` and `Profile` are not in the Zod schema is because of the **separation of concerns** in this architecture:

## 1. **Schema vs Relations Distinction**

- **Zod Schema**: Defines the **direct properties** of the `User` model itself (what's stored in the `users` table)
- **Relation Metadata**: Defines **relationships** to other models (how `User` connects to `Post` and `Profile`)

## 2. **Database Structure vs Application Logic**

```typescript
// What's stored in the User table (Zod schema)
static zodSchema = z.object({
  id: z.string().uuid().optional(),
  email: z.string().email(),
  name: z.string().min(2),
  age: z.number().min(0).optional(),
  avatar: z.string().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional()
  // NO relation fields here - they're foreign keys in database, not direct properties
});

// How User relates to other models (application logic)
static relationMetadata = {
  posts: {
    model: Post,       // Related model class
    relationType: "oneToMany"  // Nature of relationship
  },
  profile: {
    model: Profile,
    relationType: "oneToOne"
  }
};
```

## 3. **Database vs ORM Perspective**

- **Database level**: The `users` table might have `profile_id` foreign key, but this is handled by Prisma
- **Application level**: You work with nested objects like `user.posts` or `user.profile`
- **Validation level**: Zod validates the structure, relation metadata handles the relationships

## 4. **When Relations Appear in Validation**

Relations would only appear in Zod schema if you're doing **nested writes/creates**:

```typescript
// If you want to support creating user with posts in one operation
static zodSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  posts: z.array(z.object({      // This would be in Zod schema
    title: z.string(),
    content: z.string()
  })).optional()
});
```

## 5. **The `validateNestedData` Method Purpose**

The `validateNestedData` method uses **both** the Zod schema AND relation metadata:

- Zod schema validates the direct properties
- Relation metadata helps with recursive validation of nested relations

So the separation is intentional - Zod handles the model's own data structure, while relation metadata handles how it connects to other models.

## User

so give full code od three models

## Assistant

Here's the complete code for three interconnected models:

## 1. User Model

```typescript
// models/User.ts
import { BaseModel } from "./BaseModel.js";
import { z } from "zod";
import { Post } from "./Post.js";
import { Profile } from "./Profile.js";

export class User extends BaseModel {
  static modelName = "User";
  static relationFields: string[] = ["posts", "profile"];
  static fileFields: string[] = ["avatar"];

  static zodSchema = z.object({
    id: z.string().uuid().optional(),
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(0).optional(),
    avatar: z.string().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  });

  static queryWhitelist = {
    rawQueryEnabled: true,
    tables: ["users", "posts", "profiles"],
    columns: {
      users: [
        "id",
        "email",
        "name",
        "age",
        "avatar",
        "created_at",
        "updated_at",
      ],
      posts: ["id", "title", "content", "author_id", "created_at"],
      profiles: ["id", "bio", "user_id", "created_at"],
    },
    allowedOperations: ["SELECT", "UPDATE", "INSERT"],
  };

  static relationMetadata = {
    posts: {
      model: Post,
      relationType: "oneToMany",
    },
    profile: {
      model: Profile,
      relationType: "oneToOne",
    },
  };
}
```

## 2. Post Model

```typescript
// models/Post.ts
import { BaseModel } from "./BaseModel.js";
import { z } from "zod";
import { User } from "./User.js";

export class Post extends BaseModel {
  static modelName = "Post";
  static relationFields: string[] = ["author"];
  static fileFields: string[] = [];

  static zodSchema = z.object({
    id: z.string().uuid().optional(),
    title: z.string().min(1).max(255),
    content: z.string().min(1),
    authorId: z.string().uuid().optional(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  });

  static queryWhitelist = {
    rawQueryEnabled: true,
    tables: ["posts", "users"],
    columns: {
      posts: [
        "id",
        "title",
        "content",
        "author_id",
        "created_at",
        "updated_at",
      ],
      users: ["id", "email", "name"],
    },
    allowedOperations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  };

  static relationMetadata = {
    author: {
      model: User,
      relationType: "manyToOne",
    },
  };
}
```

## 3. Profile Model

```typescript
// models/Profile.ts
import { BaseModel } from "./BaseModel.js";
import { z } from "zod";
import { User } from "./User.js";

export class Profile extends BaseModel {
  static modelName = "Profile";
  static relationFields: string[] = ["user"];
  static fileFields: string[] = [];

  static zodSchema = z.object({
    id: z.string().uuid().optional(),
    bio: z.string().max(500).optional(),
    location: z.string().max(100).optional(),
    website: z.string().url().optional(),
    userId: z.string().uuid(),
    createdAt: z.date().optional(),
    updatedAt: z.date().optional(),
  });

  static queryWhitelist = {
    rawQueryEnabled: false, // Profiles don't need raw queries
    tables: ["profiles"],
    columns: {
      profiles: [
        "id",
        "bio",
        "location",
        "website",
        "user_id",
        "created_at",
        "updated_at",
      ],
    },
    allowedOperations: ["SELECT", "UPDATE"],
  };

  static relationMetadata = {
    user: {
      model: User,
      relationType: "oneToOne",
    },
  };
}
```

## Usage Example

```typescript
// Example usage showing the relationships
async function createUserWithPosts() {
  // Create user
  const user = await User.prisma.user.create({
    data: {
      email: "john@example.com",
      name: "John Doe",
      age: 30,
    },
  });

  // Create profile for user
  const profile = await Profile.prisma.profile.create({
    data: {
      bio: "Software developer",
      userId: user.id,
    },
  });

  // Create posts for user
  const posts = await Post.prisma.post.createMany({
    data: [
      { title: "First Post", content: "Hello world!", authorId: user.id },
      { title: "Second Post", content: "Another post", authorId: user.id },
    ],
  });

  // Fetch user with relations
  const userWithRelations = await User.prisma.user.findUnique({
    where: { id: user.id },
    include: {
      posts: true,
      profile: true,
    },
  });

  // Validate nested data (useful for API input)
  const userData = {
    email: "jane@example.com",
    name: "Jane Smith",
    posts: [{ title: "Jane's Post", content: "My first post" }],
  };

  try {
    const validated = await User.validateNestedData(userData);
    console.log("Validated data:", validated);
  } catch (error) {
    console.error("Validation failed:", error);
  }
}
```

## Key Points:

1. **Circular Dependencies**: All models import each other, which works in ES modules
2. **Database Fields**: Zod schemas match Prisma schema fields (camelCase in JS, snake_case in DB)
3. **Relation Types**: Properly defined relationship types for ORM understanding
4. **Query Security**: Whitelists tailored to each model's needs
5. **Validation**: Supports both flat and nested data validation through the base class
