"""A small, hand-written ontology installed on first run so every screen can be tried before an AI model
is configured. Also the canned answer of the stand-in model used by the tests (tests/fake_llm.py)."""

NAME = "Sample: Retail order management"
DOMAIN = "Retail order management"
SCOPE = ("Customers placing orders for products through stores and online channels; pricing, payment, "
         "shipment and returns. Excludes procurement from suppliers, staff scheduling and accounting.")

STANDARDS = [
    {"id": "schema", "relevance": "high", "name": "Schema.org",
     "how_used": "Backbone for parties, products, offers and orders. Core classes are declared equivalent to or "
                 "subclasses of schema.org types so data can be published and exchanged without mapping.",
     "reused_terms": ["schema:Order", "schema:OrderItem", "schema:Product", "schema:Offer", "schema:Person",
                      "schema:Organization", "schema:ParcelDelivery", "schema:Invoice", "schema:PostalAddress"]},
    {"id": "gr", "relevance": "high", "name": "GoodRelations",
     "how_used": "Commercial detail that schema.org leaves thin: price specifications, sales channels and stores.",
     "reused_terms": ["gr:Offering", "gr:UnitPriceSpecification", "gr:Location", "gr:BusinessEntity"]},
    {"id": "gs1", "relevance": "medium", "name": "GS1 Web Vocabulary & EPCIS",
     "how_used": "Product identification (GTIN) and the shipment events used for tracking.",
     "reused_terms": ["gs1:Product", "gs1:gtin", "gs1:Place"]},
    {"id": "skos", "relevance": "medium", "name": "SKOS - Simple Knowledge Organization System",
     "how_used": "Product categories form a SKOS-style hierarchy; status code lists are controlled values.",
     "reused_terms": ["skos:Concept", "skos:broader"]},
    {"id": "time", "relevance": "low", "name": "OWL-Time",
     "how_used": "Pattern for the dated lifecycle events of an order.", "reused_terms": ["time:Instant"]},
]

MODULES = [
    {"id": "Party", "name": "Parties", "description": "The people and organisations involved in a sale, and how to reach them."},
    {"id": "Catalogue", "name": "Product catalogue", "description": "What is sold: products, their categories and the offers that price them."},
    {"id": "Sales", "name": "Orders and sales", "description": "Orders, their lines, where they were placed and their lifecycle."},
    {"id": "Fulfilment", "name": "Payment and fulfilment", "description": "How an order is paid for, shipped and, if needed, returned."},
]

_C = lambda i, parent, module, definition, aligned="", alignment="", label=None, synonyms=(), abstract=False: {  # noqa: E731
    "id": i, "label": label, "parent": parent, "module": module, "definition": definition, "aligned_to": aligned,
    "alignment": alignment, "synonyms": list(synonyms), "abstract": abstract}

CLASSES = [
    _C("Party", None, "Party", "A person or organisation that can take part in a sale, as buyer or seller.", "gr:BusinessEntity", "related", abstract=True),
    _C("Person", "Party", "Party", "An individual human being.", "schema:Person", "equivalent"),
    _C("Organization", "Party", "Party", "A company or other body acting as one party.", "schema:Organization", "equivalent"),
    _C("Customer", "Party", "Party", "A party that has placed, or registered to place, orders.", "schema:Person", "related", synonyms=["buyer", "shopper"]),
    _C("Retailer", "Organization", "Party", "The organisation that sells the products and operates the sales channels.", synonyms=["merchant", "seller"]),
    _C("Address", None, "Party", "A postal location used for billing or delivery.", "schema:PostalAddress", "equivalent"),
    _C("Product", None, "Catalogue", "A distinct article offered for sale, identified by a SKU and usually a GTIN.", "schema:Product", "equivalent", synonyms=["item", "SKU"]),
    _C("ProductCategory", None, "Catalogue", "A grouping of products in the merchandise hierarchy; categories nest.", "skos:Concept", "subclass", "Product category"),
    _C("Brand", None, "Catalogue", "The trade name under which a product is marketed.", "schema:Brand", "equivalent"),
    _C("Offer", None, "Catalogue", "A product made available at a stated price through a channel for a period.", "schema:Offer", "equivalent"),
    _C("Promotion", None, "Catalogue", "A time-limited discount or incentive that can reduce the price of order lines."),
    _C("SalesChannel", None, "Sales", "A route through which orders are taken.", "gr:Location", "related", "Sales channel", abstract=True),
    _C("Store", "SalesChannel", "Sales", "A physical shop where customers buy in person.", "schema:Store", "equivalent", synonyms=["branch", "outlet"]),
    _C("OnlineChannel", "SalesChannel", "Sales", "A website, app or marketplace through which orders are placed.", label="Online channel"),
    _C("Order", None, "Sales", "A customer's commitment to buy one or more products at agreed prices.", "schema:Order", "equivalent", synonyms=["sales order", "purchase"]),
    _C("OrderLine", None, "Sales", "One product within an order, with its quantity and the price actually charged.", "schema:OrderItem", "equivalent", "Order line"),
    _C("OrderStatus", None, "Sales", "The stage an order has reached in its lifecycle.", "schema:OrderStatus", "equivalent", "Order status"),
    _C("Payment", None, "Fulfilment", "Money received from a customer against an order.", "schema:PayAction", "related"),
    _C("PaymentMethod", None, "Fulfilment", "The means by which a payment is made.", "schema:PaymentMethod", "equivalent", "Payment method"),
    _C("Invoice", None, "Fulfilment", "The bill issued to the customer for an order.", "schema:Invoice", "equivalent"),
    _C("Shipment", None, "Fulfilment", "A physical consignment carrying some or all lines of an order to an address.", "schema:ParcelDelivery", "equivalent", synonyms=["delivery", "consignment"]),
    _C("Carrier", "Organization", "Fulfilment", "An organisation that transports shipments.", synonyms=["courier"]),
    _C("ReturnRequest", None, "Fulfilment", "A customer's request to send back delivered products for refund or exchange.", label="Return request", synonyms=["return", "RMA"]),
    _C("ReturnReason", None, "Fulfilment", "The stated cause of a return.", label="Return reason"),
]

_O = lambda i, d, r, definition, card="0..*", inverse="", label=None: {  # noqa: E731
    "id": i, "kind": "object", "domain": d, "range": r, "definition": definition, "cardinality": card, "inverse": inverse, "label": label}
_D = lambda i, d, r, definition, card="0..1", label=None: {  # noqa: E731
    "id": i, "kind": "data", "domain": d, "range": r, "definition": definition, "cardinality": card, "label": label}

PROPERTIES = [
    _O("hasAddress", "Party", "Address", "An address at which the party can be reached."),
    _O("placedBy", "Order", "Customer", "The customer who placed the order.", "1", "places", "placed by"),
    _O("places", "Customer", "Order", "An order this customer placed.", "0..*", "placedBy"),
    _O("placedThrough", "Order", "SalesChannel", "The store or online channel where the order was taken.", "1", label="placed through"),
    _O("soldBy", "Order", "Retailer", "The retailer that is the seller of record.", "1", label="sold by"),
    _O("hasLine", "Order", "OrderLine", "A line belonging to the order.", "1..*", "lineOf", "has line"),
    _O("lineOf", "OrderLine", "Order", "The order this line belongs to.", "1", "hasLine", "line of"),
    _O("forProduct", "OrderLine", "Product", "The product ordered on this line.", "1", label="for product"),
    _O("underOffer", "OrderLine", "Offer", "The offer whose price applied to this line.", "0..1", label="under offer"),
    _O("appliedPromotion", "OrderLine", "Promotion", "A promotion that reduced the price of this line.", label="applied promotion"),
    _O("hasStatus", "Order", "OrderStatus", "The current lifecycle stage of the order.", "1", label="has status"),
    _O("shipTo", "Order", "Address", "The address the order is to be delivered to.", "0..1", label="ship to"),
    _O("inCategory", "Product", "ProductCategory", "The category the product is classified under.", "1..*", label="in category"),
    _O("broaderCategory", "ProductCategory", "ProductCategory", "The parent category.", "0..1", label="broader category"),
    _O("hasBrand", "Product", "Brand", "The brand the product is sold under.", "0..1", label="has brand"),
    _O("offers", "Offer", "Product", "The product this offer prices.", "1"),
    _O("availableThrough", "Offer", "SalesChannel", "A channel in which the offer is valid.", "1..*", label="available through"),
    _O("paysFor", "Payment", "Order", "The order this payment settles, in full or in part.", "1", label="pays for"),
    _O("usesMethod", "Payment", "PaymentMethod", "How the payment was made.", "1", label="uses method"),
    _O("invoices", "Invoice", "Order", "The order this invoice bills.", "1"),
    _O("fulfils", "Shipment", "Order", "The order this shipment delivers.", "1", "fulfilledBy"),
    _O("fulfilledBy", "Order", "Shipment", "A shipment delivering this order.", "0..*", "fulfils", "fulfilled by"),
    _O("carriedBy", "Shipment", "Carrier", "The carrier transporting the shipment.", "0..1", label="carried by"),
    _O("deliveredTo", "Shipment", "Address", "The address the shipment goes to.", "1", label="delivered to"),
    _O("returnOf", "ReturnRequest", "OrderLine", "The order line being returned.", "1..*", label="return of"),
    _O("hasReason", "ReturnRequest", "ReturnReason", "Why the products are being returned.", "1", label="has reason"),
    _D("partyName", "Party", "string", "The name the party is known by.", "1", "name"),
    _D("email", "Party", "string", "Contact email address."),
    _D("customerSince", "Customer", "date", "Date the customer first registered or ordered.", label="customer since"),
    _D("loyaltyTier", "Customer", "string", "Level in the loyalty programme, if enrolled.", label="loyalty tier"),
    _D("postalCode", "Address", "string", "Postal or ZIP code.", label="postal code"),
    _D("city", "Address", "string", "Town or city."),
    _D("country", "Address", "string", "Country, as an ISO 3166 code."),
    _D("sku", "Product", "string", "The retailer's stock-keeping code for the product.", "1", "SKU"),
    _D("gtin", "Product", "string", "Global Trade Item Number (barcode).", label="GTIN"),
    _D("productName", "Product", "string", "The product's display name.", "1", "name"),
    _D("categoryName", "ProductCategory", "string", "The category's display name.", "1", "name"),
    _D("listPrice", "Offer", "decimal", "The unit price before promotions.", "1", "list price"),
    _D("validFrom", "Offer", "date", "First day the offer applies.", label="valid from"),
    _D("validTo", "Offer", "date", "Last day the offer applies.", label="valid to"),
    _D("discountPercent", "Promotion", "decimal", "Percentage taken off the list price.", label="discount %"),
    _D("orderNumber", "Order", "string", "The retailer's reference for the order.", "1", "order number"),
    _D("orderDate", "Order", "dateTime", "When the order was placed.", "1", "order date"),
    _D("orderTotal", "Order", "decimal", "Total amount charged, including tax and delivery.", "1", "order total"),
    _D("quantity", "OrderLine", "integer", "Number of units ordered.", "1"),
    _D("unitPrice", "OrderLine", "decimal", "Price charged per unit after promotions.", "1", "unit price"),
    _D("lineAmount", "OrderLine", "decimal", "Quantity multiplied by unit price.", "1", "line amount"),
    _D("paidAmount", "Payment", "decimal", "Amount received.", "1", "paid amount"),
    _D("paidOn", "Payment", "dateTime", "When the payment was received.", "1", "paid on"),
    _D("invoiceNumber", "Invoice", "string", "The invoice's reference.", "1", "invoice number"),
    _D("shippedOn", "Shipment", "dateTime", "When the shipment left the warehouse or store.", label="shipped on"),
    _D("deliveredOn", "Shipment", "dateTime", "When the shipment was handed to the customer.", label="delivered on"),
    _D("trackingNumber", "Shipment", "string", "The carrier's tracking reference.", label="tracking number"),
    _D("requestedOn", "ReturnRequest", "date", "When the return was requested.", "1", "requested on"),
    _D("refundAmount", "ReturnRequest", "decimal", "Amount refunded to the customer.", label="refund amount"),
    _D("storeCode", "Store", "string", "The retailer's code for the store.", "1", "store code"),
    _D("channelName", "SalesChannel", "string", "The channel's display name.", "1", "name"),
]

INDIVIDUALS = [{"id": i, "type": t, "label": l, "definition": d} for i, t, l, d in [
    ("Placed", "OrderStatus", "Placed", "Order received, not yet paid."),
    ("Paid", "OrderStatus", "Paid", "Payment received in full."),
    ("Shipped", "OrderStatus", "Shipped", "All lines have left for delivery."),
    ("Delivered", "OrderStatus", "Delivered", "All lines received by the customer."),
    ("Cancelled", "OrderStatus", "Cancelled", "Order stopped before shipment."),
    ("Card", "PaymentMethod", "Card", "Credit or debit card."),
    ("CashOnDelivery", "PaymentMethod", "Cash on delivery", "Paid in cash when delivered."),
    ("BankTransfer", "PaymentMethod", "Bank transfer", "Direct transfer or UPI."),
    ("Damaged", "ReturnReason", "Damaged", "Arrived damaged or faulty."),
    ("WrongItem", "ReturnReason", "Wrong item", "Not the product that was ordered."),
    ("ChangedMind", "ReturnReason", "Changed mind", "No longer wanted."),
]]

RULES = [
    {"id": "R1", "label": "Line amount", "kind": "derivation", "applies_to": ["OrderLine"],
     "statement": "The line amount of an order line equals its quantity multiplied by its unit price."},
    {"id": "R2", "label": "Shipment needs payment", "kind": "constraint", "applies_to": ["Shipment", "Order"],
     "statement": "A shipment can only be created for an order whose status is Paid, unless the payment method is Cash on delivery."},
    {"id": "R3", "label": "Return window", "kind": "constraint", "applies_to": ["ReturnRequest"],
     "statement": "A return can only be requested for an order line that has been delivered."},
    {"id": "R4", "label": "Store or online", "kind": "disjoint", "applies_to": ["Store", "OnlineChannel"],
     "statement": "A sales channel is either a store or an online channel, never both."},
]

EXPLANATION = {
    "summary": "This ontology describes how a retailer sells products to customers: who buys, what is sold and at what price, "
               "how an order is placed through a store or online, and how it is paid for, shipped and sometimes returned. "
               "It gives sales, fulfilment and customer-service systems one shared vocabulary.",
    "purpose": "Used by analysts to answer questions that span sales, fulfilment and returns; by integration teams as the "
               "target model when connecting the e-commerce platform, point of sale and warehouse systems; and as the schema "
               "of a customer and order knowledge graph.",
    "scope_in": ["Customers and their addresses", "Products, categories, brands, offers and promotions",
                 "Orders and order lines across stores and online channels", "Payments, invoices, shipments and returns"],
    "scope_out": ["Purchasing from suppliers and inventory replenishment", "Staff, rosters and store operations",
                  "General ledger accounting and tax filing"],
    "how_to_read": "Start from Order. An Order is placed by a Customer through a Sales channel (a Store or an Online channel) "
                   "and has one or more Order lines; each line is for a Product and records the quantity and the unit price "
                   "charged, optionally under an Offer and with a Promotion applied. Products sit in Product categories, which "
                   "nest. On the fulfilment side a Payment pays for the Order, an Invoice bills it, and one or more Shipments "
                   "fulfil it, carried by a Carrier to an Address. A Return request refers back to the Order lines returned.",
    "module_notes": {
        "Party": "People and organisations. Customer, Retailer and Carrier are all kinds of Party, so names, emails and addresses are defined once.",
        "Catalogue": "The assortment. An Offer, not the Product, carries the price - the same product can be priced differently per channel and period.",
        "Sales": "The commercial transaction. Order holds the header facts; Order line holds what was bought. Order status is a controlled list.",
        "Fulfilment": "Everything after the sale: money in (Payment, Invoice), goods out (Shipment, Carrier) and goods back (Return request).",
    },
    "design_decisions": [
        {"title": "Price lives on the offer and on the order line",
         "text": "List price belongs to Offer; the price actually charged is copied to Order line. Putting price on Product "
                 "would lose channel-specific pricing and the history of what each customer paid."},
        {"title": "Customer is a role-like subclass of Party",
         "text": "Customer, Retailer and Carrier share Party's attributes. The alternative, separate unrelated classes, "
                 "would repeat name and address three times and block questions such as 'all parties at this address'."},
        {"title": "Statuses are controlled values, not text",
         "text": "Order status, payment method and return reason are classes with a fixed list of values, so reports group reliably."},
    ],
    "standards_approach": "Schema.org supplies the backbone (Order, OrderItem, Product, Offer, Person, Organization) and GoodRelations "
                          "the commercial detail; GS1 identifies products. Returns and promotions are modelled new, because the "
                          "published vocabularies treat them only superficially.",
}

USE_CASES = [
    {"id": "UC1", "title": "Revenue by product category", "actor": "Category manager",
     "question": "What was the revenue of each product category last month?",
     "description": "The basic sales performance view. It needs the amount on every order line and the category of the product on that line, for orders in the period.",
     "classes": ["Order", "OrderLine", "Product", "ProductCategory"],
     "properties": ["hasLine", "forProduct", "inCategory", "lineAmount", "orderDate", "categoryName"],
     "answer_path": ["Start from Orders whose order date falls in the month.", "Follow has line to each Order line and read its line amount.",
                     "Follow for product to the Product, then in category to its Product category.", "Sum line amount per category name."],
     "sparql": "SELECT ?category (SUM(?amount) AS ?revenue) WHERE {\n  ?order a :Order ; :orderDate ?d ; :hasLine ?line .\n  ?line :lineAmount ?amount ; :forProduct ?p .\n  ?p :inCategory ?c . ?c :categoryName ?category .\n  FILTER(?d >= \"2025-06-01T00:00:00\"^^xsd:dateTime && ?d < \"2025-07-01T00:00:00\"^^xsd:dateTime)\n} GROUP BY ?category ORDER BY DESC(?revenue)",
     "sample_answer": "Footwear 412,300; Outerwear 388,950; Accessories 96,120."},
    {"id": "UC2", "title": "Orders paid but not shipped", "actor": "Fulfilment lead",
     "question": "Which paid orders have not been shipped yet, and how long have they been waiting?",
     "description": "An operational exception list. It joins the order's status and payment date with the absence of a shipment.",
     "classes": ["Order", "OrderStatus", "Payment", "Shipment", "Customer"],
     "properties": ["hasStatus", "paysFor", "paidOn", "fulfilledBy", "placedBy", "orderNumber"],
     "answer_path": ["Select Orders whose has status is Paid.", "Keep those with no fulfilled by link to a Shipment.",
                     "From the Payment that pays for the order, read paid on to compute the waiting time.", "Show order number and the Customer it was placed by."],
     "sparql": "SELECT ?number ?paidOn WHERE {\n  ?o a :Order ; :orderNumber ?number ; :hasStatus :Paid .\n  ?pay :paysFor ?o ; :paidOn ?paidOn .\n  FILTER NOT EXISTS { ?o :fulfilledBy ?s }\n} ORDER BY ?paidOn",
     "sample_answer": "SO-10482 paid 3 days ago; SO-10511 paid 2 days ago."},
    {"id": "UC3", "title": "Return rate by reason and channel", "actor": "Customer-service manager",
     "question": "What share of order lines are returned, by return reason and by sales channel?",
     "description": "Shows whether returns are driven by product quality or by the buying channel. It links returns back through the order line to the order's channel.",
     "classes": ["ReturnRequest", "ReturnReason", "OrderLine", "Order", "SalesChannel"],
     "properties": ["returnOf", "hasReason", "lineOf", "placedThrough", "channelName"],
     "answer_path": ["Start from Return requests and read has reason.", "Follow return of to the Order lines, then line of to the Order.",
                     "Follow placed through to the Sales channel.", "Count returned lines per reason and channel and divide by all lines of that channel."],
     "sparql": "SELECT ?channel ?reason (COUNT(?line) AS ?returned) WHERE {\n  ?r a :ReturnRequest ; :hasReason ?reason ; :returnOf ?line .\n  ?line :lineOf ?o . ?o :placedThrough ?ch . ?ch :channelName ?channel .\n} GROUP BY ?channel ?reason",
     "sample_answer": "Web shop: Wrong item 1.2%, Damaged 0.8%. Stores: Changed mind 0.4%."},
    {"id": "UC4", "title": "Customer order history", "actor": "Customer-service agent",
     "question": "Show everything a given customer ordered, with delivery status and tracking number.",
     "description": "The lookup behind a service call: a customer's orders, what was on them and where each shipment is.",
     "classes": ["Customer", "Order", "OrderLine", "Product", "Shipment", "OrderStatus"],
     "properties": ["places", "hasLine", "forProduct", "fulfilledBy", "trackingNumber", "deliveredOn", "hasStatus", "productName", "orderDate"],
     "answer_path": ["Find the Customer by name or email.", "Follow places to their Orders and read order date and has status.",
                     "For each Order follow has line and for product to list what was bought.", "Follow fulfilled by to Shipments for tracking number and delivered on."],
     "sparql": "SELECT ?date ?status ?product ?tracking WHERE {\n  ?c a :Customer ; :email \"asha@example.com\" ; :places ?o .\n  ?o :orderDate ?date ; :hasStatus ?status ; :hasLine ?l . ?l :forProduct ?p . ?p :productName ?product .\n  OPTIONAL { ?o :fulfilledBy ?s . ?s :trackingNumber ?tracking }\n} ORDER BY DESC(?date)",
     "sample_answer": "12 Jun - Delivered - Trail shoe (tracking 1Z88…); 30 May - Shipped - Rain jacket."},
]


def content() -> dict:
    from . import catalogue, onto
    stds = []
    for s in STANDARDS:
        ref = catalogue.BY_ID[s["id"]]
        stds.append({**s, **{k: ref[k] for k in ("name", "publisher", "url", "prefix", "namespace", "kind")}, "in_catalogue": True})
    c = onto.clean({"meta": {"name": NAME, "domain": DOMAIN, "scope": SCOPE}, "standards": stds, "modules": MODULES, "classes": CLASSES,
                    "properties": PROPERTIES, "individuals": INDIVIDUALS, "rules": RULES, "explanation": EXPLANATION, "use_cases": USE_CASES})
    return c
