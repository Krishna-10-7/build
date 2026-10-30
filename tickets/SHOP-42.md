---
key: SHOP-42
title: Cart and checkout for ShopLite
status: Ready for QA
---
Shoppers can add a product to the cart from its page, see the running total, and place an order.

## Acceptance criteria

- AC-1: Given the shopper is on "/product/clay-mug", when they click "Add to cart", then the "cart badge" shows "1".
- AC-2: Given the shopper is on "/product/clay-mug", when they set "Quantity" to "2", click "Add to cart" and open "/cart", then the "cart total" shows "₹698".
- AC-3: Given the shopper is on "/product/clay-mug", when they click "Add to cart", open "/cart", click "Checkout" taking them to "/checkout", set "Full name" to "Asha Rao", set "Email" to "asha@example.com" and click "Place order", then the "order status" contains "Order placed".
