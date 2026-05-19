const mongoose = require("mongoose");
const { GALLERY_IMAGE_URLS } = require("../config/galleryImages");

const galleryFieldSectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    area: { type: String, enum: ["general", "extras"], default: "general" },
    isCustom: { type: Boolean, default: false },
  },
  { _id: false },
);

const galleryOptionCatalogSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, required: true, trim: true },
    options: [{ type: String, trim: true }],
  },
  { _id: false },
);

const galleryOptionPriceSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, required: true, trim: true },
    sectionTitle: { type: String, required: true, trim: true },
    option: { type: String, required: true, trim: true },
    price: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const galleryCombinationSelectionSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, required: true, trim: true },
    sectionTitle: { type: String, required: true, trim: true },
    option: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const galleryCombinationPriceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    price: { type: Number, default: 0, min: 0 },
    isEnabled: { type: Boolean, default: true },
    selections: {
      type: [galleryCombinationSelectionSchema],
      default: [],
    },
  },
  { _id: false },
);

const gallerySectionOptionSchema = new mongoose.Schema(
  {
    sectionKey: { type: String, required: true, trim: true },
    options: [{ type: String, trim: true }],
  },
  { _id: false },
);

const galleryCustomSectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    area: { type: String, enum: ["general", "extras"], default: "general" },
    options: [{ type: String, trim: true }],
  },
  { _id: false },
);

const defaultGalleryFieldSections = () => [
  { key: "cakeTypes", title: "Cake Type", area: "general", isCustom: false },
  { key: "eggOptions", title: "Egg Type", area: "general", isCustom: false },
  { key: "flavors", title: "Flavor", area: "general", isCustom: false },
  { key: "fondantOptions", title: "Fondant", area: "general", isCustom: false },
  { key: "photoOptions", title: "Photo", area: "extras", isCustom: false },
  { key: "extras", title: "Extras", area: "extras", isCustom: false },
];

const defaultGalleryOptionCatalogs = () => [
  { sectionKey: "cakeTypes", options: ["Cool cake", "Butter Cream cake"] },
  { sectionKey: "eggOptions", options: ["Egg", "Eggless"] },
  {
    sectionKey: "flavors",
    options: [
      "Vanilla",
      "Butterscotch",
      "Strawberry",
      "Chocolate",
      "Pineapple",
      "Red Velvet",
    ],
  },
  { sectionKey: "fondantOptions", options: ["Full fondant", "Semi fondant"] },
  {
    sectionKey: "photoOptions",
    options: ["Edible photo", "Non edible photo"],
  },
  { sectionKey: "extras", options: ["Deposit", "Doll"] },
];

const galleryFieldConfigSchema = new mongoose.Schema(
  {
    fieldSections: {
      type: [galleryFieldSectionSchema],
      default: defaultGalleryFieldSections,
    },
    optionCatalogs: {
      type: [galleryOptionCatalogSchema],
      default: defaultGalleryOptionCatalogs,
    },
    optionPrices: {
      type: [galleryOptionPriceSchema],
      default: [],
    },
    combinationPrices: {
      type: [galleryCombinationPriceSchema],
      default: [],
    },
  },
  { _id: false },
);

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
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
    priceLabel: {
      type: String,
      default: "Starting at",
      trim: true,
    },
    configurationNote: {
      type: String,
      default: "",
      trim: true,
    },
    optionPrices: {
      type: [
        {
          sectionKey: { type: String, required: true, trim: true },
          sectionTitle: { type: String, required: true, trim: true },
          option: { type: String, required: true, trim: true },
          price: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },
    sectionOptions: {
      type: [gallerySectionOptionSchema],
      default: [],
    },
    cakeTypes: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: ["Cool cake", "Butter Cream cake"],
    },
    eggOptions: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: ["Egg", "Eggless"],
    },
    weightRange: {
      min: {
        type: Number,
        default: 1,
        min: 0,
      },
      max: {
        type: Number,
        default: 5,
        min: 0,
      },
      unit: {
        type: String,
        default: "kg",
        trim: true,
      },
    },
    flavors: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: [
        "Vanilla",
        "Butterscotch",
        "Strawberry",
        "Chocolate",
        "Pineapple",
        "Red Velvet",
      ],
    },
    fondantOptions: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: ["Full fondant", "Semi fondant"],
    },
    photoOptions: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: ["Edible photo", "Non edible photo"],
    },
    extras: {
      type: [
        {
          type: String,
          trim: true,
        },
      ],
      default: ["Deposit", "Doll"],
    },
    fieldSections: {
      type: [galleryFieldSectionSchema],
      default: defaultGalleryFieldSections,
    },
    customSections: {
      type: [galleryCustomSectionSchema],
      default: [],
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

const categorySettingSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false },
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
        default: "+91 9490459499",
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
        default: "https://wa.me/9194904594990",
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
    categorySettings: {
      type: [categorySettingSchema],
      default: [
        { name: "cakes", isActive: true },
        { name: "pastries", isActive: true },
        { name: "breads", isActive: true },
        { name: "cookies", isActive: true },
        { name: "custom", isActive: true },
      ],
    },
    galleryFieldConfig: {
      type: galleryFieldConfigSchema,
      default: () => ({
        fieldSections: defaultGalleryFieldSections(),
        optionCatalogs: defaultGalleryOptionCatalogs(),
      }),
    },
    galleryItems: {
      type: [galleryItemSchema],
      default: [
        {
          title: "Wedding Elegance",
          description: "Three-tier floral wedding cake",
          category: "Wedding",
          imageUrl: GALLERY_IMAGE_URLS.cake1,
          likes: 234,
          price: 3500,
          priceLabel: "Starting at",
          configurationNote: "Custom floral work priced after design confirmation",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 2, max: 8, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Birthday Fun",
          description: "Colorful birthday cake with drip",
          category: "Birthday",
          imageUrl: GALLERY_IMAGE_URLS.cake2,
          likes: 189,
          price: 1800,
          priceLabel: "Starting at",
          configurationNote: "Price depends on weight and topper details",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 5, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Chocolate Indulgence",
          description: "Rich dark chocolate cake with ganache drip",
          category: "Custom",
          imageUrl: GALLERY_IMAGE_URLS.cake3,
          likes: 312,
          price: 2200,
          priceLabel: "Starting at",
          configurationNote: "Ganache finish and toppings affect final price",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 6, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Fresh Fruit Delight",
          description: "Light vanilla sponge topped with fresh fruits",
          category: "Custom",
          imageUrl: GALLERY_IMAGE_URLS.cake4,
          likes: 156,
          price: 2000,
          priceLabel: "Starting at",
          configurationNote: "Seasonal fruit selection may change pricing",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 6, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Red Velvet Dream",
          description: "Classic red velvet with cream cheese frosting",
          category: "Birthday",
          imageUrl: GALLERY_IMAGE_URLS.cake5,
          likes: 278,
          price: 1900,
          priceLabel: "Starting at",
          configurationNote: "Message, size, and decor can be configured",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 5, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Golden Anniversary",
          description: "Luxurious gold-themed celebration cake",
          category: "Wedding",
          imageUrl: GALLERY_IMAGE_URLS.cake6,
          likes: 198,
          price: 4200,
          priceLabel: "Starting at",
          configurationNote: "Metallic finish and tiers are priced separately",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 2, max: 10, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Party Confetti Cake",
          description: "Funfetti cake with rainbow sprinkles",
          category: "Birthday",
          imageUrl: GALLERY_IMAGE_URLS.cake7,
          likes: 167,
          price: 1600,
          priceLabel: "Starting at",
          configurationNote: "Theme color changes available on request",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 4, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
        {
          title: "Gourmet Cupcake Collection",
          description: "Assorted premium cupcakes and toppings",
          category: "Cupcakes",
          imageUrl: GALLERY_IMAGE_URLS.cake8,
          likes: 245,
          price: 900,
          priceLabel: "Starting at",
          configurationNote: "Per-dozen pricing varies by flavor assortment",
          cakeTypes: ["Cool cake", "Butter Cream cake"],
          eggOptions: ["Egg", "Eggless"],
          weightRange: { min: 1, max: 3, unit: "kg" },
          flavors: [
            "Vanilla",
            "Butterscotch",
            "Strawberry",
            "Chocolate",
            "Pineapple",
            "Red Velvet",
          ],
          fondantOptions: ["Full fondant", "Semi fondant"],
          photoOptions: ["Edible photo", "Non edible photo"],
          extras: ["Deposit", "Doll"],
        },
      ],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SiteContent", siteContentSchema);
