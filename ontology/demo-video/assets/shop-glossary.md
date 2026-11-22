# BrightMart shop data - glossary

- **Customer**: a person with an account. `tier` is the loyalty level: Gold, Silver or Bronze.
- **Order**: one purchase. `status` moves through Placed, Paid, Shipped, Delivered. A Cancelled order was stopped before shipment.
- **Order line**: one product on an order, with a quantity (`qty`) and the unit `price` in rupees.
- **Product**: something we sell, identified by its `sku`.
- An order's `total` is the sum of its lines.
