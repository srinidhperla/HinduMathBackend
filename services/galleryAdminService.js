const imageStorage = require("./cloudinaryStorage");

const DEFAULT_GALLERY_OPTIONS = {
  cakeTypes: ["Cool cake", "Butter Cream cake"],
  eggOptions: ["Egg", "Eggless"],
  weightRange: {
    min: 1,
    max: 5,
    unit: "kg",
  },
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
};

const DEFAULT_GALLERY_FIELD_SECTIONS = [
  { key: "cakeTypes", title: "Cake Type", area: "general", isCustom: false },
  { key: "eggOptions", title: "Egg Type", area: "general", isCustom: false },
  { key: "flavors", title: "Flavor", area: "general", isCustom: false },
  {
    key: "fondantOptions",
    title: "Fondant",
    area: "general",
    isCustom: false,
  },
  { key: "photoOptions", title: "Photo", area: "extras", isCustom: false },
  { key: "extras", title: "Extras", area: "extras", isCustom: false },
];

const BUILT_IN_SECTION_KEYS = Object.keys(DEFAULT_GALLERY_OPTIONS).filter(
  (key) => key !== "weightRange",
);

const toUniqueOptions = (items = []) =>
  Array.from(
    new Set(items.map((entry) => String(entry || "").trim()).filter(Boolean)),
  );

const parseNonNegativeNumber = (value, fallback = 0) => {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? numericValue
    : fallback;
};

const parseJsonValue = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeStringArray = (value, fallback = []) => {
  const source = parseJsonValue(value, value);

  if (Array.isArray(source)) {
    return toUniqueOptions(source);
  }

  if (typeof source === "string") {
    return toUniqueOptions(source.split(","));
  }

  return toUniqueOptions(fallback);
};

const normalizeWeightRange = (value, fallback = {}) => {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? value
      : parseJsonValue(value, {});

  const min = parseNonNegativeNumber(
    source?.min,
    parseNonNegativeNumber(fallback?.min, 0),
  );
  const maxCandidate = parseNonNegativeNumber(
    source?.max,
    parseNonNegativeNumber(fallback?.max, min),
  );

  return {
    min,
    max: maxCandidate >= min ? maxCandidate : min,
    unit: String(source?.unit || fallback?.unit || "kg").trim() || "kg",
  };
};

const normalizeFieldSections = (value, fallback = []) => {
  const source = parseJsonValue(value, fallback);

  if (!Array.isArray(source)) {
    return Array.isArray(fallback) && fallback.length > 0
      ? fallback
      : DEFAULT_GALLERY_FIELD_SECTIONS;
  }

  const normalized = source
    .map((section) => ({
      key: String(section?.key || "").trim(),
      title: String(section?.title || "").trim(),
      area: section?.area === "extras" ? "extras" : "general",
      isCustom: Boolean(section?.isCustom),
    }))
    .filter((section) => section.key && section.title);

  return Array.isArray(source)
    ? normalized
    : normalized.length
    ? normalized
    : Array.isArray(fallback) && fallback.length > 0
      ? fallback
      : DEFAULT_GALLERY_FIELD_SECTIONS;
};

const normalizeOptionCatalogs = (
  value,
  fieldSections = [],
  fallback = [],
  includeDefaultCatalogs = false,
) => {
  const source = parseJsonValue(value, fallback);
  const fallbackEntries = Array.isArray(fallback) ? fallback : [];
  const catalogMap = new Map();

  if (includeDefaultCatalogs) {
    Object.entries(DEFAULT_GALLERY_OPTIONS).forEach(([sectionKey, options]) => {
      if (sectionKey !== "weightRange") {
        catalogMap.set(sectionKey, toUniqueOptions(options));
      }
    });
  }

  fallbackEntries.forEach((entry) => {
    const sectionKey = String(entry?.sectionKey || "").trim();
    if (sectionKey) {
      catalogMap.set(sectionKey, toUniqueOptions(entry?.options || []));
    }
  });

  if (Array.isArray(source)) {
    source.forEach((entry) => {
      const sectionKey = String(entry?.sectionKey || "").trim();
      if (sectionKey) {
        catalogMap.set(sectionKey, toUniqueOptions(entry?.options || []));
      }
    });
  }

  return fieldSections.map((section) => ({
    sectionKey: section.key,
    options: toUniqueOptions(catalogMap.get(section.key) || []),
  }));
};

const normalizeOptionPrices = (value, fallback = []) => {
  const source = parseJsonValue(value, fallback);

  if (!Array.isArray(source)) {
    return Array.isArray(fallback) ? fallback : [];
  }

  return source
    .map((entry) => ({
      sectionKey: String(entry?.sectionKey || "").trim(),
      sectionTitle: String(entry?.sectionTitle || "").trim(),
      option: String(entry?.option || "").trim(),
      price: parseNonNegativeNumber(entry?.price, 0),
    }))
    .filter((entry) => entry.sectionKey && entry.option);
};

const normalizeCombinationPrices = (value, fallback = []) => {
  const source = parseJsonValue(value, fallback);

  if (!Array.isArray(source)) {
    return Array.isArray(fallback) ? fallback : [];
  }

  return source
    .map((entry) => ({
      key: String(entry?.key || "").trim(),
      label: String(entry?.label || "").trim(),
      price: parseNonNegativeNumber(entry?.price, 0),
      isEnabled: entry?.isEnabled !== false,
      selections: Array.isArray(entry?.selections)
        ? entry.selections
            .map((selection) => ({
              sectionKey: String(selection?.sectionKey || "").trim(),
              sectionTitle: String(selection?.sectionTitle || "").trim(),
              option: String(selection?.option || "").trim(),
            }))
            .filter((selection) => selection.sectionKey && selection.option)
        : [],
    }))
    .filter((entry) => entry.key);
};

const normalizeSectionOptions = (value, fallback = []) => {
  const source = parseJsonValue(value, fallback);

  if (!Array.isArray(source)) {
    return Array.isArray(fallback) ? fallback : [];
  }

  return source
    .map((entry) => ({
      sectionKey: String(entry?.sectionKey || "").trim(),
      options: toUniqueOptions(entry?.options || []),
    }))
    .filter((entry) => entry.sectionKey);
};

const buildDefaultGalleryFieldConfig = () => ({
  fieldSections: DEFAULT_GALLERY_FIELD_SECTIONS.map((section) => ({ ...section })),
  optionCatalogs: BUILT_IN_SECTION_KEYS.map((sectionKey) => ({
    sectionKey,
    options: toUniqueOptions(DEFAULT_GALLERY_OPTIONS[sectionKey] || []),
  })),
  optionPrices: [],
  combinationPrices: [],
});

const buildLegacySelectionMap = (item = {}) => {
  const selectionMap = new Map();

  BUILT_IN_SECTION_KEYS.forEach((sectionKey) => {
    selectionMap.set(sectionKey, normalizeStringArray(item?.[sectionKey], []));
  });

  if (Array.isArray(item?.customSections)) {
    item.customSections.forEach((section) => {
      const sectionKey = String(section?.key || "").trim();
      if (sectionKey) {
        selectionMap.set(
          sectionKey,
          normalizeStringArray(item?.[sectionKey] || section?.options, []),
        );
      }
    });
  }

  return selectionMap;
};

const buildSelectionMapFromItem = (item = {}) => {
  const rawSectionOptions = Array.isArray(item?.sectionOptions)
    ? item.sectionOptions
    : [];

  if (rawSectionOptions.length > 0) {
    return new Map(
      rawSectionOptions
        .map((entry) => [
          String(entry?.sectionKey || "").trim(),
          normalizeStringArray(entry?.options, []),
        ])
        .filter(([sectionKey]) => sectionKey),
    );
  }

  return buildLegacySelectionMap(item);
};

const getGalleryFieldConfig = (source = {}) => {
  const fallbackConfig = buildDefaultGalleryFieldConfig();
  const derivedSections = [];
  const derivedCatalogMap = new Map(
    fallbackConfig.optionCatalogs.map((entry) => [entry.sectionKey, entry.options]),
  );

  const rawConfig =
    source?.galleryFieldConfig && typeof source.galleryFieldConfig === "object"
      ? source.galleryFieldConfig
      : {};
  const hasExplicitConfig = Array.isArray(rawConfig.fieldSections);
  const hasExplicitCatalogs = Array.isArray(rawConfig.optionCatalogs);

  const fieldSections = normalizeFieldSections(
    rawConfig.fieldSections,
    hasExplicitConfig ? [] : fallbackConfig.fieldSections,
  );

  const optionCatalogs = normalizeOptionCatalogs(
    rawConfig.optionCatalogs,
    fieldSections,
    hasExplicitCatalogs ? [] : fallbackConfig.optionCatalogs,
    !hasExplicitConfig && !hasExplicitCatalogs,
  );
  const optionPrices = normalizeOptionPrices(
    rawConfig.optionPrices,
    hasExplicitCatalogs || hasExplicitConfig ? [] : fallbackConfig.optionPrices,
  );
  const combinationPrices = normalizeCombinationPrices(
    rawConfig.combinationPrices,
    hasExplicitCatalogs || hasExplicitConfig ? [] : fallbackConfig.combinationPrices,
  );

  if (hasExplicitConfig || hasExplicitCatalogs) {
    return { fieldSections, optionCatalogs, optionPrices, combinationPrices };
  }

  const galleryItems = Array.isArray(source?.galleryItems) ? source.galleryItems : [];
  galleryItems.forEach((item) => {
    const itemSections = normalizeFieldSections(
      item?.fieldSections,
      fallbackConfig.fieldSections,
    );
    const itemSectionMap = new Map();

    itemSections.forEach((section) => {
      if (!derivedSections.some((entry) => entry.key === section.key)) {
        derivedSections.push(section);
      }
      itemSectionMap.set(section.key, section);
    });

    buildSelectionMapFromItem(item).forEach((options, sectionKey) => {
      const section = itemSectionMap.get(sectionKey);
      const nextOptions = stripImplicitToggleOptions(section, options);
      if (!nextOptions.length) {
        return;
      }

      derivedCatalogMap.set(
        sectionKey,
        toUniqueOptions([...(derivedCatalogMap.get(sectionKey) || []), ...nextOptions]),
      );
    });

    if (Array.isArray(item?.customSections)) {
      item.customSections.forEach((section) => {
        const sectionKey = String(section?.key || "").trim();
        if (!sectionKey) {
          return;
        }

        const normalizedSection =
          itemSectionMap.get(sectionKey) ||
          normalizeFieldSections([section], [section])[0];
        const nextOptions = stripImplicitToggleOptions(
          normalizedSection,
          section?.options || [],
        );
        if (!nextOptions.length) {
          return;
        }

        derivedCatalogMap.set(
          sectionKey,
          toUniqueOptions([
            ...(derivedCatalogMap.get(sectionKey) || []),
            ...nextOptions,
          ]),
        );
      });
    }
  });

  const resolvedSections = derivedSections.length
    ? derivedSections
    : fallbackConfig.fieldSections;

  return {
    fieldSections: resolvedSections,
    optionCatalogs: resolvedSections.map((section) => ({
      sectionKey: section.key,
      options: toUniqueOptions(derivedCatalogMap.get(section.key) || []),
    })),
    optionPrices,
    combinationPrices,
  };
};

const buildGalleryFieldConfigPayload = (
  value,
  fallbackConfig = buildDefaultGalleryFieldConfig(),
) => {
  const source = parseJsonValue(value, value);
  const hasExplicitConfig = Array.isArray(source?.fieldSections);
  const hasExplicitCatalogs = Array.isArray(source?.optionCatalogs);
  const fieldSections = normalizeFieldSections(
    source?.fieldSections,
    hasExplicitConfig ? [] : fallbackConfig.fieldSections,
  );
  const optionCatalogs = normalizeOptionCatalogs(
    source?.optionCatalogs,
    fieldSections,
    hasExplicitCatalogs ? [] : fallbackConfig.optionCatalogs,
    !hasExplicitConfig && !hasExplicitCatalogs,
  );

  return {
    fieldSections,
    optionCatalogs,
    optionPrices: normalizeOptionPrices(
      source?.optionPrices,
      hasExplicitCatalogs || hasExplicitConfig ? [] : fallbackConfig.optionPrices,
    ),
    combinationPrices: normalizeCombinationPrices(
      source?.combinationPrices,
      hasExplicitCatalogs || hasExplicitConfig
        ? []
        : fallbackConfig.combinationPrices,
    ),
  };
};

const buildOptionCatalogMap = (galleryFieldConfig = {}) =>
  Object.fromEntries(
    (galleryFieldConfig.optionCatalogs || []).map((entry) => [
      entry.sectionKey,
      toUniqueOptions(entry.options || []),
    ]),
  );

const buildFieldTitleMap = (galleryFieldConfig = {}) =>
  Object.fromEntries(
    (galleryFieldConfig.fieldSections || []).map((section) => [
      section.key,
      section.title,
    ]),
  );

const isDirectToggleSection = (section = {}) =>
  section?.area === "extras" && Boolean(section?.isCustom);

const stripImplicitToggleOptions = (section = {}, options = []) => {
  const normalizedOptions = toUniqueOptions(options || []);

  if (
    isDirectToggleSection(section) &&
    normalizedOptions.length === 1 &&
    normalizedOptions[0] === String(section?.title || "").trim()
  ) {
    return [];
  }

  return normalizedOptions;
};

const getAllowedSectionOptions = (section = {}, optionCatalogMap = {}) => {
  const configuredOptions = toUniqueOptions(optionCatalogMap[section.key] || []);

  if (configuredOptions.length > 0) {
    return configuredOptions;
  }

  if (isDirectToggleSection(section)) {
    return toUniqueOptions([section.title]);
  }

  return [];
};

const normalizeGalleryFieldMutations = (value) => {
  const source = parseJsonValue(value, []);

  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((entry) => ({
      type: String(entry?.type || "").trim(),
      sectionKey: String(entry?.sectionKey || "").trim(),
      area: entry?.area === "extras" ? "extras" : "general",
      title: String(entry?.title || "").trim(),
      previousTitle: String(entry?.previousTitle || "").trim(),
      option: String(entry?.option || "").trim(),
      previousOption: String(entry?.previousOption || "").trim(),
      isCustom: Boolean(entry?.isCustom),
    }))
    .filter((entry) => entry.type);
};

const applyMutationsToItem = (item = {}, mutations = []) => {
  const selectionMap = buildSelectionMapFromItem(item);
  let nextOptionPrices = normalizeOptionPrices(item?.optionPrices, []);

  mutations.forEach((mutation) => {
    if (!mutation?.sectionKey) {
      return;
    }

    const currentSelections = selectionMap.get(mutation.sectionKey) || [];

    switch (mutation.type) {
      case "rename_field":
        if (
          mutation.previousTitle &&
          mutation.title &&
          mutation.area === "extras" &&
          mutation.isCustom
        ) {
          selectionMap.set(
            mutation.sectionKey,
            currentSelections.map((entry) =>
              entry === mutation.previousTitle ? mutation.title : entry,
            ),
          );
          nextOptionPrices = nextOptionPrices.map((entry) =>
            entry.sectionKey === mutation.sectionKey &&
            entry.option === mutation.previousTitle
              ? { ...entry, option: mutation.title }
              : entry,
          );
        }
        nextOptionPrices = nextOptionPrices.map((entry) =>
          entry.sectionKey === mutation.sectionKey
            ? { ...entry, sectionTitle: mutation.title || entry.sectionTitle }
            : entry,
        );
        break;
      case "delete_field":
        selectionMap.delete(mutation.sectionKey);
        nextOptionPrices = nextOptionPrices.filter(
          (entry) => entry.sectionKey !== mutation.sectionKey,
        );
        break;
      case "rename_option":
        if (mutation.previousOption && mutation.option) {
          selectionMap.set(
            mutation.sectionKey,
            currentSelections.map((entry) =>
              entry === mutation.previousOption ? mutation.option : entry,
            ),
          );
          nextOptionPrices = nextOptionPrices.map((entry) =>
            entry.sectionKey === mutation.sectionKey &&
            entry.option === mutation.previousOption
              ? { ...entry, option: mutation.option }
              : entry,
          );
        }
        break;
      case "delete_option":
        if (mutation.option) {
          selectionMap.set(
            mutation.sectionKey,
            currentSelections.filter((entry) => entry !== mutation.option),
          );
          nextOptionPrices = nextOptionPrices.filter(
            (entry) =>
              !(
                entry.sectionKey === mutation.sectionKey &&
                entry.option === mutation.option
              ),
          );
        }
        break;
      default:
        break;
    }
  });

  return {
    selectionMap,
    optionPrices: nextOptionPrices,
  };
};

const applyGalleryFieldConfigToItem = (
  item = {},
  galleryFieldConfig = buildDefaultGalleryFieldConfig(),
  mutations = [],
) => {
  const optionCatalogMap = buildOptionCatalogMap(galleryFieldConfig);
  const fieldTitleMap = buildFieldTitleMap(galleryFieldConfig);
  const { selectionMap, optionPrices } = applyMutationsToItem(item, mutations);

  const sectionOptions = galleryFieldConfig.fieldSections.map((section) => ({
    sectionKey: section.key,
    options: toUniqueOptions(selectionMap.get(section.key) || []).filter((option) =>
      getAllowedSectionOptions(section, optionCatalogMap).includes(option),
    ),
  }));

  const customSections = galleryFieldConfig.fieldSections
    .filter((section) => section.isCustom)
    .map((section) => ({
      key: section.key,
      title: section.title,
      area: section.area,
      options: toUniqueOptions(optionCatalogMap[section.key] || []),
    }));

  const normalizedOptionPrices = optionPrices
    .map((entry) => ({
      sectionKey: entry.sectionKey,
      sectionTitle: fieldTitleMap[entry.sectionKey] || entry.sectionTitle,
      option: entry.option,
      price: parseNonNegativeNumber(entry.price, 0),
    }))
    .filter(
      (entry) =>
        fieldTitleMap[entry.sectionKey] &&
        getAllowedSectionOptions(
          galleryFieldConfig.fieldSections.find(
            (section) => section.key === entry.sectionKey,
          ) || {},
          optionCatalogMap,
        ).includes(entry.option),
    );

  const nextPayload = {
    fieldSections: galleryFieldConfig.fieldSections.map((section) => ({ ...section })),
    customSections,
    sectionOptions,
    optionPrices: normalizedOptionPrices,
  };

  BUILT_IN_SECTION_KEYS.forEach((sectionKey) => {
    nextPayload[sectionKey] =
      sectionOptions.find((entry) => entry.sectionKey === sectionKey)?.options || [];
  });

  return nextPayload;
};

const buildGalleryItemPayload = (
  source = {},
  fallbackItem = null,
  galleryFieldConfig = buildDefaultGalleryFieldConfig(),
) => {
  const optionCatalogMap = buildOptionCatalogMap(galleryFieldConfig);
  const fieldTitleMap = buildFieldTitleMap(galleryFieldConfig);
  const fallbackSelections = buildSelectionMapFromItem(fallbackItem || {});
  const sourceSectionOptions = normalizeSectionOptions(
    source.sectionOptions,
    fallbackItem?.sectionOptions || [],
  );

  const sourceSelectionMap =
    sourceSectionOptions.length > 0
      ? new Map(
          sourceSectionOptions.map((entry) => [
            entry.sectionKey,
            normalizeStringArray(entry.options, []),
          ]),
        )
      : new Map();

  BUILT_IN_SECTION_KEYS.forEach((sectionKey) => {
    if (source[sectionKey] !== undefined) {
      sourceSelectionMap.set(
        sectionKey,
        normalizeStringArray(source[sectionKey], fallbackSelections.get(sectionKey) || []),
      );
    } else if (!sourceSelectionMap.has(sectionKey)) {
      sourceSelectionMap.set(sectionKey, fallbackSelections.get(sectionKey) || []);
    }
  });

  const normalizedBase = {
    title: String(source.title || fallbackItem?.title || "").trim(),
    category: String(source.category || fallbackItem?.category || "").trim(),
    description: String(
      source.description ?? fallbackItem?.description ?? "",
    ).trim(),
    likes: parseNonNegativeNumber(source.likes, fallbackItem?.likes || 0),
    price: parseNonNegativeNumber(source.price, fallbackItem?.price || 0),
    priceLabel:
      String(source.priceLabel || fallbackItem?.priceLabel || "").trim() ||
      "Starting at",
    configurationNote: String(
      source.configurationNote ?? fallbackItem?.configurationNote ?? "",
    ).trim(),
    weightRange: normalizeWeightRange(
      source.weightRange,
      fallbackItem?.weightRange || DEFAULT_GALLERY_OPTIONS.weightRange,
    ),
  };

  const itemWithSelections = {
    ...fallbackItem,
    ...normalizedBase,
    sectionOptions: galleryFieldConfig.fieldSections.map((section) => ({
      sectionKey: section.key,
      options: toUniqueOptions(
        sourceSelectionMap.get(section.key) || fallbackSelections.get(section.key) || [],
      ).filter((option) =>
        getAllowedSectionOptions(section, optionCatalogMap).includes(option),
      ),
    })),
    optionPrices: normalizeOptionPrices(
      source.optionPrices,
      fallbackItem?.optionPrices || [],
    ).map((entry) => ({
      sectionKey: entry.sectionKey,
      sectionTitle: fieldTitleMap[entry.sectionKey] || entry.sectionTitle,
      option: entry.option,
      price: parseNonNegativeNumber(entry.price, 0),
    })),
  };

  const configAppliedPayload = applyGalleryFieldConfigToItem(
    itemWithSelections,
    galleryFieldConfig,
  );

  return {
    ...normalizedBase,
    ...configAppliedPayload,
  };
};

const syncGalleryItemsWithFieldConfig = (
  galleryItems = [],
  galleryFieldConfig = buildDefaultGalleryFieldConfig(),
  mutations = [],
) => {
  galleryItems.forEach((galleryItem) => {
    Object.assign(
      galleryItem,
      applyGalleryFieldConfigToItem(galleryItem, galleryFieldConfig, mutations),
    );
  });
};

const formatGalleryItemResponse = (galleryItem) => {
  const source =
    galleryItem && typeof galleryItem.toObject === "function"
      ? galleryItem.toObject()
      : { ...galleryItem };

  return {
    ...source,
    imageUrl: imageStorage.optimizeDeliveryUrl(source.imageUrl),
  };
};

module.exports = {
  DEFAULT_GALLERY_FIELD_SECTIONS,
  DEFAULT_GALLERY_OPTIONS,
  applyGalleryFieldConfigToItem,
  buildGalleryFieldConfigPayload,
  buildGalleryItemPayload,
  formatGalleryItemResponse,
  getGalleryFieldConfig,
  normalizeGalleryFieldMutations,
  syncGalleryItemsWithFieldConfig,
};
