const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

dotenv.config();

const User = require("./models/User");
const Product = require("./models/Product");

const seedData = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(
      process.env.MONGODB_URI ||
        "mongodb://localhost:27017/hindumatha-cake-world",
    );
    console.log("Connected to MongoDB");

    // Clear existing data
    await User.deleteMany({});
    await Product.deleteMany({});
    console.log("Cleared existing data");

    // Create admin user
    const adminUser = new User({
      name: "Admin",
      email: "admin@hindumathascakes.com",
      password: "admin123",
      role: "admin",
      phone: "94904594990",
    });
    await adminUser.save();
    console.log("Admin user created: admin@hindumathascakes.com / admin123");

    // Create test user
    const testUser = new User({
      name: "Test User",
      email: "test@example.com",
      password: "test123",
      role: "user",
      phone: "9490459499",
    });
    await testUser.save();
    console.log("Test user created: test@example.com / test123");

    // Create products
    const products = [
      {
        name: "Wedding Cake",
        description:
          "Elegant three-tier wedding cake with custom decorations. Perfect for your special day.",
        price: 2999,
        category: "cakes",
        image: "/images/gallery/cake1.jpg",
        flavors: ["Vanilla", "Chocolate", "Red Velvet"],
        sizes: ["2kg", "3kg", "5kg"],
        occasion: ["Wedding", "Anniversary"],
        isAvailable: true,
      },
      {
        name: "Birthday Cake",
        description:
          "Delicious chocolate cake perfect for birthdays with custom decorations.",
        price: 899,
        category: "cakes",
        image: "/images/gallery/cake2.jpg",
        flavors: ["Chocolate", "Vanilla", "Butterscotch"],
        sizes: ["500g", "1kg", "1.5kg"],
        occasion: ["Birthday", "Party"],
        isAvailable: true,
      },
      {
        name: "Chocolate Truffle",
        description: "Rich chocolate truffle cake with ganache topping.",
        price: 799,
        category: "cakes",
        image: "/images/gallery/cake3.jpg",
        flavors: ["Dark Chocolate", "Milk Chocolate"],
        sizes: ["500g", "1kg"],
        occasion: ["Birthday", "Party", "Gift"],
        isAvailable: true,
      },
      {
        name: "Fruit Cake",
        description: "Fresh seasonal fruits with cream cheese frosting.",
        price: 699,
        category: "cakes",
        image: "/images/gallery/cake4.jpg",
        flavors: ["Mixed Fruit", "Strawberry", "Mango"],
        sizes: ["500g", "1kg"],
        occasion: ["Birthday", "Party"],
        isAvailable: true,
      },
      {
        name: "Red Velvet Cake",
        description: "Classic red velvet cake with cream cheese frosting.",
        price: 999,
        category: "cakes",
        image: "/images/gallery/cake5.jpg",
        flavors: ["Red Velvet"],
        sizes: ["500g", "1kg", "1.5kg"],
        occasion: ["Birthday", "Anniversary", "Valentine"],
        isAvailable: true,
      },
      {
        name: "Anniversary Special",
        description: "Special cake designed for anniversary celebrations.",
        price: 1499,
        category: "cakes",
        image: "/images/gallery/cake6.jpg",
        flavors: ["Vanilla", "Butterscotch", "Chocolate"],
        sizes: ["1kg", "1.5kg", "2kg"],
        occasion: ["Anniversary"],
        isAvailable: true,
      },
      {
        name: "Party Cake",
        description: "Fun and colorful cake perfect for parties.",
        price: 1299,
        category: "cakes",
        image: "/images/gallery/cake7.jpg",
        flavors: ["Rainbow", "Chocolate", "Vanilla"],
        sizes: ["1kg", "2kg"],
        occasion: ["Birthday", "Party"],
        isAvailable: true,
      },
      {
        name: "Assorted Cupcakes",
        description: "Box of 6 assorted flavor cupcakes.",
        price: 399,
        category: "pastries",
        image: "/images/gallery/cake8.jpg",
        flavors: ["Mixed"],
        sizes: ["6 pieces", "12 pieces"],
        occasion: ["Birthday", "Party", "Gift"],
        isAvailable: true,
      },
      {
        name: "Chocolate Pastry",
        description: "Rich chocolate pastry with cream filling.",
        price: 99,
        category: "pastries",
        image: "/images/gallery/cake3.jpg",
        flavors: ["Chocolate"],
        sizes: ["Single"],
        occasion: ["Snack"],
        isAvailable: true,
      },
      {
        name: "Butter Cookies",
        description: "Pack of homemade butter cookies (250g).",
        price: 199,
        category: "cookies",
        image: "/images/gallery/cake8.jpg",
        flavors: ["Butter", "Chocolate Chip"],
        sizes: ["250g", "500g"],
        occasion: ["Gift", "Snack"],
        isAvailable: true,
      },
      {
        name: "Fresh Bread Loaf",
        description: "Freshly baked whole wheat bread.",
        price: 49,
        category: "breads",
        image: "/images/gallery/cake4.jpg",
        flavors: ["Whole Wheat", "White"],
        sizes: ["400g"],
        occasion: ["Daily"],
        isAvailable: true,
      },
      {
        name: "Custom Designer Cake",
        description: "Fully customizable designer cake for any occasion.",
        price: 1999,
        category: "custom",
        image: "/images/gallery/cake1.jpg",
        flavors: ["Any"],
        sizes: ["1kg", "2kg", "3kg"],
        customization: {
          available: true,
          options: [
            { name: "Photo Print", choices: ["Yes", "No"], price: 200 },
            {
              name: "Fondant Design",
              choices: ["Basic", "Premium"],
              price: 500,
            },
          ],
        },
        occasion: ["Birthday", "Wedding", "Anniversary", "Custom"],
        isAvailable: true,
      },
    ];

    await Product.insertMany(products);
    console.log(`${products.length} products created`);

    console.log("\nâœ… Database seeded successfully!");
    console.log("\nYou can now login with:");
    console.log("Admin: admin@hindumathascakes.com / admin123");
    console.log("User: test@example.com / test123");

    process.exit(0);
  } catch (error) {
    console.error("Error seeding database:", error);
    process.exit(1);
  }
};

seedData();
