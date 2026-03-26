const mongoose = require("mongoose");

const galleryItemSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    category: {
      type: String,
      required: true,
      trim: true,
    },
    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },
    likes: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    type: {
      type: String,
      enum: ["percent", "flat", "delivery"],
      required: true,
    },
    value: {
      type: Number,
      default: 0,
      min: 0,
    },
    minSubtotal: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxDiscount: {
      type: Number,
      default: null,
      min: 0,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true },
);

const deliverySlotSchema = new mongoose.Schema(
  {
    startTime: {
      type: String,
      default: "09:00",
      trim: true,
    },
    endTime: {
      type: String,
      default: "21:00",
      trim: true,
    },
  },
  { _id: false },
);

const deliveryDaySchema = new mongoose.Schema(
  {
    isOpen: {
      type: Boolean,
      default: true,
    },
    slots: {
      type: [deliverySlotSchema],
      default: [{ startTime: "09:00", endTime: "21:00" }],
    },
  },
  { _id: false },
);

const defaultWeeklySchedule = () => ({
  monday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "21:00" }] },
  tuesday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "21:00" }] },
  wednesday: {
    isOpen: true,
    slots: [{ startTime: "09:00", endTime: "21:00" }],
  },
  thursday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "21:00" }] },
  friday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "21:00" }] },
  saturday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "22:00" }] },
  sunday: { isOpen: true, slots: [{ startTime: "09:00", endTime: "22:00" }] },
});

const siteContentSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: "default",
      unique: true,
    },
    businessInfo: {
      storeName: {
        type: String,
        default: "Hindumatha's Cake World",
      },
      establishedYear: {
        type: Number,
        default: 1976,
        min: 1900,
      },
      email: {
        type: String,
        default: "info@hindumathascakes.com",
      },
      phone: {
        type: String,
        default: "+91 98765 43210",
      },
      address: {
        type: String,
        default: "123 Main Street, Vizianagaram, Andhra Pradesh",
      },
      intro: {
        type: String,
        default:
          "Crafting unforgettable cakes for every celebration since 2010.",
      },
    },
    storeHours: {
      weekdays: {
        type: String,
        default: "8:00 AM - 9:00 PM",
      },
      weekends: {
        type: String,
        default: "9:00 AM - 10:00 PM",
      },
    },
    deliverySettings: {
      enabled: {
        type: Boolean,
        default: true,
      },
      distanceFeeEnabled: {
        type: Boolean,
        default: true,
      },
      pricePerKm: {
        type: Number,
        default: 20,
        min: 0,
      },
      firstKmFee: {
        type: Number,
        default: 20,
        min: 0,
      },
      pricePerKmBeyondFirstKm: {
        type: Number,
        default: 20,
        min: 0,
      },
      freeDeliveryEnabled: {
        type: Boolean,
        default: true,
      },
      freeDeliveryMinAmount: {
        type: Number,
        default: 1500,
        min: 0,
      },
      maxDeliveryRadiusKm: {
        type: Number,
        default: 3,
        min: 0,
      },
      storeLocation: {
        lat: { type: Number, default: 0 },
        lng: { type: Number, default: 0 },
      },
      pauseUntil: {
        type: Date,
        default: null,
      },
      pauseDurationUnit: {
        type: String,
        enum: ["hours", "days"],
        default: "hours",
      },
      pauseDurationValue: {
        type: Number,
        default: 0,
        min: 0,
      },
      prepTimeMinutes: {
        type: Number,
        default: 45,
        min: 0,
      },
      advanceNoticeUnit: {
        type: String,
        enum: ["hours", "days"],
        default: "hours",
      },
      advanceNoticeValue: {
        type: Number,
        default: 2,
        min: 0,
      },
      timeSlots: {
        type: [
          {
            type: String,
            trim: true,
          },
        ],
        default: ["09:00-12:00", "12:00-15:00", "15:00-18:00", "18:00-21:00"],
      },
      weeklySchedule: {
        monday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().monday,
        },
        tuesday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().tuesday,
        },
        wednesday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().wednesday,
        },
        thursday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().thursday,
        },
        friday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().friday,
        },
        saturday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().saturday,
        },
        sunday: {
          type: deliveryDaySchema,
          default: () => defaultWeeklySchedule().sunday,
        },
      },
    },
    socialLinks: {
      instagram: {
        type: String,
        default: "https://instagram.com/yourbakery",
      },
      facebook: {
        type: String,
        default: "https://facebook.com/yourbakery",
      },
      whatsapp: {
        type: String,
        default: "https://wa.me/919876543210",
      },
    },
    coupons: {
      type: [couponSchema],
      default: [
        {
          code: "SWEET10",
          type: "percent",
          value: 10,
          minSubtotal: 500,
          maxDiscount: 250,
          description: "10% off on orders above Rs.500",
          isActive: true,
        },
        {
          code: "WELCOME100",
          type: "flat",
          value: 100,
          minSubtotal: 800,
          description: "Rs.100 off on orders above Rs.800",
          isActive: true,
        },
        {
          code: "FREEDEL",
          type: "delivery",
          value: 0,
          minSubtotal: 400,
          description: "Free delivery on eligible orders",
          isActive: true,
        },
      ],
    },
    categoryOrder: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
        },
      ],
      default: ["cakes", "pastries", "breads", "cookies", "custom"],
    },
    galleryItems: {
      type: [galleryItemSchema],
      default: [
        {
          title: "Wedding Elegance",
          description: "Three-tier floral wedding cake",
          category: "Wedding",
          imageUrl: "/images/gallery/cake1.jpg",
          likes: 234,
        },
        {
          title: "Birthday Fun",
          description: "Colorful birthday cake with drip",
          category: "Birthday",
          imageUrl: "/images/gallery/cake2.jpg",
          likes: 189,
        },
        {
          title: "Chocolate Indulgence",
          description: "Rich dark chocolate cake with ganache drip",
          category: "Custom",
          imageUrl: "/images/gallery/cake3.jpg",
          likes: 312,
        },
        {
          title: "Fresh Fruit Delight",
          description: "Light vanilla sponge topped with fresh fruits",
          category: "Custom",
          imageUrl: "/images/gallery/cake4.jpg",
          likes: 156,
        },
        {
          title: "Red Velvet Dream",
          description: "Classic red velvet with cream cheese frosting",
          category: "Birthday",
          imageUrl: "/images/gallery/cake5.jpg",
          likes: 278,
        },
        {
          title: "Golden Anniversary",
          description: "Luxurious gold-themed celebration cake",
          category: "Wedding",
          imageUrl: "/images/gallery/cake6.jpg",
          likes: 198,
        },
        {
          title: "Party Confetti Cake",
          description: "Funfetti cake with rainbow sprinkles",
          category: "Birthday",
          imageUrl: "/images/gallery/cake7.jpg",
          likes: 167,
        },
        {
          title: "Gourmet Cupcake Collection",
          description: "Assorted premium cupcakes and toppings",
          category: "Cupcakes",
          imageUrl: "/images/gallery/cake8.jpg",
          likes: 245,
        },
      ],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SiteContent", siteContentSchema);
