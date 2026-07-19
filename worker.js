const EASYBROKER_API = "https://api.easybroker.com/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (!env.EASYBROKER_API_KEY) {
        return textResponse(
          "Falta configurar el secreto EASYBROKER_API_KEY.",
          500
        );
      }

      if (url.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          service: "APEX Realty EasyBroker Meta Feed",
          updated_at: new Date().toISOString()
        });
      }

      if (url.pathname === "/debug") {
        const properties = await getAllProperties(env.EASYBROKER_API_KEY);

        return jsonResponse({
          total: properties.length,
          properties: properties.slice(0, 3)
        });
      }

      if (url.pathname === "/" || url.pathname === "/feed.xml") {
        const summaries = await getAllProperties(env.EASYBROKER_API_KEY);
        const properties = await getPropertyDetails(
          summaries,
          env.EASYBROKER_API_KEY
        );

        const xml = createMetaFeed(properties);

        return new Response(xml, {
          status: 200,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=1800",
            "Content-Disposition": 'inline; filename="apex-realty-feed.xml"',
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      return textResponse("Ruta no encontrada.", 404);
    } catch (error) {
      console.error("Feed error:", error);

      return jsonResponse(
        {
          status: "error",
          message: error instanceof Error ? error.message : String(error)
        },
        500
      );
    }
  }
};

async function getAllProperties(apiKey) {
  const properties = [];
  const limit = 50;
  let page = 1;
  let continueLoading = true;

  while (continueLoading && page <= 20) {
    const endpoint =
      `${EASYBROKER_API}/properties?page=${page}&limit=${limit}`;

    const data = await easyBrokerRequest(endpoint, apiKey);
    const content = Array.isArray(data.content) ? data.content : [];

    properties.push(...content);

    const pagination = data.pagination || {};
    const totalPages =
      Number(pagination.total_pages) ||
      Number(pagination.pages) ||
      null;

    if (totalPages) {
      continueLoading = page < totalPages;
    } else {
      continueLoading = content.length === limit;
    }

    page += 1;
  }

  return properties;
}

async function getPropertyDetails(summaries, apiKey) {
  const results = [];
  const batchSize = 5;

  for (let index = 0; index < summaries.length; index += batchSize) {
    const batch = summaries.slice(index, index + batchSize);

    const details = await Promise.all(
      batch.map(async (property) => {
        const propertyId =
          property.public_id ||
          property.id ||
          property.property_id;

        if (!propertyId) {
          return property;
        }

        try {
          return await easyBrokerRequest(
            `${EASYBROKER_API}/properties/${encodeURIComponent(propertyId)}`,
            apiKey
          );
        } catch (error) {
          console.warn(
            `No fue posible obtener el detalle de ${propertyId}:`,
            error
          );

          return property;
        }
      })
    );

    results.push(...details);
  }

  return results;
}

async function easyBrokerRequest(endpoint, apiKey) {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "X-Authorization": apiKey,
      Accept: "application/json",
      "User-Agent": "APEX-Realty-Meta-Feed/1.0"
    }
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `EasyBroker respondió ${response.status}: ${body.slice(0, 300)}`
    );
  }

  return response.json();
}

function createMetaFeed(properties) {
  const listings = properties
    .map(createListingXml)
    .filter(Boolean)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<listings>
${listings}
</listings>`;
}

function createListingXml(property) {
  const operation = selectOperation(property.operations);

  if (!operation || !operation.amount) {
    return "";
  }

  const publicId =
    property.public_id ||
    property.id ||
    property.property_id;

  if (!publicId) {
    return "";
  }

  const location = property.location || {};
  const images = Array.isArray(property.property_images)
    ? property.property_images
    : Array.isArray(property.images)
      ? property.images
      : [];

  const imageXml = images
    .map((image) => {
      const imageUrl =
        typeof image === "string"
          ? image
          : image.url || image.original || image.image_url;

      if (!imageUrl) return "";

      return `    <image>
      <url>${escapeXml(imageUrl)}</url>
    </image>`;
    })
    .filter(Boolean)
    .join("\n");

  const listingType =
    operation.type === "rental" || operation.type === "rent"
      ? "for_rent"
      : "for_sale";

  const amount = normalizeNumber(operation.amount);
  const currency = operation.currency || "MXN";
  const price = `${amount} ${currency}`;

  const bedrooms = normalizeNumber(property.bedrooms);
  const bathrooms =
    normalizeNumber(property.bathrooms) +
    normalizeNumber(property.half_bathrooms) * 0.5;

  const area =
    normalizeNumber(property.construction_size) ||
    normalizeNumber(property.lot_size);

  const title =
    property.title ||
    `Propiedad ${publicId}`;

  const description =
    property.description ||
    title;

  const propertyUrl =
    property.url ||
    `https://www.apexrealty.mx/property/${encodeURIComponent(publicId)}`;

  return `  <listing>
    <home_listing_id>${escapeXml(publicId)}</home_listing_id>
    <name>${escapeXml(title)}</name>
    <availability>available</availability>
    <listing_type>${listingType}</listing_type>
    <property_type>${mapPropertyType(property.property_type)}</property_type>
    <price>${escapeXml(price)}</price>
    <url>${escapeXml(propertyUrl)}</url>
    <description>${escapeXml(description)}</description>
    <address>
      <addr1>${escapeXml(location.street || "")}</addr1>
      <city>${escapeXml(location.city || "")}</city>
      <region>${escapeXml(location.region || "")}</region>
      <postal_code>${escapeXml(location.postal_code || "")}</postal_code>
      <country>MX</country>
    </address>
    <latitude>${escapeXml(location.latitude || "")}</latitude>
    <longitude>${escapeXml(location.longitude || "")}</longitude>
    <neighborhood>${escapeXml(location.city_area || "")}</neighborhood>
    <num_beds>${bedrooms}</num_beds>
    <num_baths>${bathrooms}</num_baths>
    <num_units>1</num_units>
    <area_size>${area}</area_size>
    <area_unit>sq_m</area_unit>
${imageXml}
  </listing>`;
}

function selectOperation(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return null;
  }

  const sale = operations.find(
    (operation) => operation.type === "sale"
  );

  const rental = operations.find(
    (operation) =>
      operation.type === "rental" ||
      operation.type === "rent"
  );

  return sale || rental || operations[0];
}

function mapPropertyType(propertyType) {
  const value = String(propertyType || "").toLowerCase();

  if (
    value.includes("departamento") ||
    value.includes("apartment")
  ) {
    return "apartment";
  }

  if (
    value.includes("condominio") ||
    value.includes("condo")
  ) {
    return "condo";
  }

  if (
    value.includes("casa") ||
    value.includes("house") ||
    value.includes("residencia")
  ) {
    return "house";
  }

  if (
    value.includes("terreno") ||
    value.includes("land") ||
    value.includes("lote")
  ) {
    return "land";
  }

  if (
    value.includes("townhouse") ||
    value.includes("casa en condominio")
  ) {
    return "townhouse";
  }

  return "other";
}

function normalizeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}
