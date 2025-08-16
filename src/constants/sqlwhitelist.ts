// Safety configurations
const QUERY_WHITELIST = {
  tables: ["users", "posts", "products"], // Allowed tables
  columns: {
    users: ["id", "email", "name"], // Allowed columns for 'users'
    // posts: "*", // Allow all columns for 'posts'
    products: ["id", "price", "sku"], // Allowed columns for 'products'
  },
};

export { QUERY_WHITELIST };

// const QUERY_WHITELIST = {
//   tables: ["users", "posts", "products"], // Allowed tables
//   columns: {
//     users: "*", // Allow all columns for 'users'
//     posts: "*", // Allow all columns for 'posts'
//     products: "*", // Allow all columns for 'products'
//   },
// };
