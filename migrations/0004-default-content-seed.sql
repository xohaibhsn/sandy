-- 0004-default-content-seed.sql
-- Default CMS rows: site_content keys, home/about sections, and starter FAQs.
-- Run AFTER 0003-admin-schema.sql. Owner review + manual run in phpMyAdmin only; the app NEVER executes this file.
--
-- ONLY adds missing rows. It contains no UPDATE, REPLACE or DELETE, so it can never overwrite or remove
-- anything the owner has already edited:
--   * site_content / sections: INSERT IGNORE on the unique content_key (existing keys are left exactly as they are).
--   * FAQs: the starter set is inserted only when the faqs table is completely empty; the three "required"
--     FAQs are inserted only when no FAQ with that exact question exists.
-- Coupons are NOT seeded (see migrations/README.md). The old IPTV/UK text rewrites and the obsolete-FAQ
-- deletes of the removed runtime code are NOT ported (see migrations/README.md).
--
-- Values are the defaults the removed runtime initialisers used (generated from them; 251 content keys,
-- 8 sections, 14 starter FAQs, 3 required FAQs).
-- The file is UTF-8 (some defaults contain emoji and typographic dashes): import it as UTF-8.

SET NAMES utf8mb4;

-- ========== PRE-CHECK ==========
SELECT DATABASE() AS current_database;
SELECT
  (SELECT COUNT(*) FROM site_content) AS site_content_rows,
  (SELECT COUNT(*) FROM faqs) AS faq_rows;

-- ========== site_content: default keys (existing keys are never touched) ==========
INSERT IGNORE INTO site_content (content_key, content_value, content_type, page_name, label) VALUES
  ('site_title', 'S&Y', 'text', 'settings', 'Website Title'),
  ('site_tagline', 'Quality products, delivered across Pakistan', 'text', 'settings', 'Website Tagline'),
  ('site_logo_url', '', 'image', 'settings', 'Site Logo'),
  ('favicon_url', '/favicon.ico', 'image', 'settings', 'Favicon URL'),
  ('og_default_image', '', 'image', 'settings', 'Default OG Share Image'),
  ('whatsapp_number', '923334800181', 'text', 'settings', 'WhatsApp Number'),
  ('whatsapp_icon_url', '', 'image', 'settings', 'WhatsApp Button Icon'),
  ('admin_low_stock_threshold', '5', 'text', 'settings', 'Admin low-stock threshold'),
  ('contact_whatsapp', '923334800181', 'text', 'settings', 'WhatsApp Number'),
  ('contact_phone', '+923334800181', 'text', 'settings', 'Phone Number'),
  ('contact_email', 'info@sandy.com.pk', 'text', 'settings', 'Contact Email'),
  ('contact_telegram', '', 'text', 'settings', 'Telegram Handle'),
  ('home_top_hero_title', 'S&Y — Quality products, delivered across Pakistan', 'text', 'home', 'Top Hero Title'),
  ('home_top_hero_subtitle', 'Handpicked quality, authentic products, fast delivery.', 'textarea', 'home', 'Top Hero Subtitle'),
  ('home_hero_title', 'Quality products, delivered across Pakistan', 'text', 'home', 'Main Hero Title'),
  ('home_hero_subtitle', 'S&Y is your Pakistani online store for accessories, gadgets and everyday essentials.', 'textarea', 'home', 'Main Hero Subtitle'),
  ('home_hero_btn_text', 'Shop Now', 'text', 'home', 'Main Hero Primary Button'),
  ('home_hero_btn_link', '/products', 'text', 'home', 'Main Hero Primary Button Link'),
  ('home_hero_btn_show', '1', 'text', 'home', 'Show Primary Button'),
  ('home_hero_btn2_text', 'Learn More', 'text', 'home', 'Main Hero Secondary Button'),
  ('home_hero_btn2_link', '/about', 'text', 'home', 'Main Hero Secondary Button Link'),
  ('home_hero_btn2_show', '1', 'text', 'home', 'Show Secondary Button'),
  ('home_stat1_num', '500+', 'text', 'home', 'Stat 1 Number'),
  ('home_stat1_label', 'Happy Customers', 'text', 'home', 'Stat 1 Label'),
  ('home_stat2_num', 'Nationwide', 'text', 'home', 'Stat 2 Number'),
  ('home_stat2_label', 'Pakistan Delivery', 'text', 'home', 'Stat 2 Label'),
  ('home_stat3_num', '24/7', 'text', 'home', 'Stat 3 Number'),
  ('home_stat3_label', 'WhatsApp Support', 'text', 'home', 'Stat 3 Label'),
  ('home_tagline', 'Handpicked quality. Fast delivery.', 'text', 'home', 'Tagline'),
  ('home_meta_title', 'S&Y — Quality products, delivered across Pakistan', 'text', 'home', 'Meta Title'),
  ('home_meta_description', 'Handpicked quality, authentic products, fast delivery. Shop accessories, gadgets and everyday essentials at S&Y.', 'textarea', 'home', 'Meta Description'),
  ('about_title', 'About S&Y', 'text', 'about', 'Page Title'),
  ('about_description', 'S&Y is a Pakistani online store based in Lahore. We started with a simple idea — quality products, honest prices, and delivery you can rely on.', 'textarea', 'about', 'Main Description'),
  ('about_mission', 'Our mission is to make everyday shopping easier across Pakistan — authentic products, fair prices, and real human support on WhatsApp.', 'textarea', 'about', 'Mission Statement'),
  ('contact_hours', '9AM – 10PM, 7 days a week', 'text', 'contact', 'Business Hours'),
  ('contact_address', 'Lahore, Pakistan', 'text', 'contact', 'Address'),
  ('footer_text', '© 2026 S&Y. All rights reserved.', 'textarea', 'footer', 'Footer Text'),
  ('footer_tagline', 'Quality products, delivered across Pakistan', 'text', 'footer', 'Footer Tagline'),
  ('hero_slide_1', '', 'image', 'settings', 'Hero Slide 1'),
  ('hero_slide_2', '', 'image', 'settings', 'Hero Slide 2'),
  ('hero_slide_3', '', 'image', 'settings', 'Hero Slide 3'),
  ('hero_slide_4', '', 'image', 'settings', 'Hero Slide 4'),
  ('home_features_list', CONCAT('Authentic, carefully selected products', CHAR(10), 'Nationwide delivery across Pakistan', CHAR(10), 'Cash on Delivery available', CHAR(10), 'JazzCash, Easypaisa and bank transfer', CHAR(10), 'WhatsApp support', CHAR(10), 'Easy returns on faulty items', CHAR(10), 'No hidden fees', CHAR(10), 'Secure checkout', CHAR(10), 'Fast order processing', CHAR(10), 'Quality you can trust'), 'textarea', 'home', 'Service Features Content'),
  ('home_hero_tag', 'S&Y · Pakistan', 'text', 'home', 'Main Hero Tag'),
  ('home_trust_1_title', 'Cash on Delivery', 'text', 'home', 'Trust 1 Title'),
  ('home_trust_1_sub', 'Pay when it arrives', 'text', 'home', 'Trust 1 Subtitle'),
  ('home_trust_2_title', 'Free Delivery', 'text', 'home', 'Trust 2 Title'),
  ('home_trust_2_sub', 'Across Pakistan', 'text', 'home', 'Trust 2 Subtitle'),
  ('home_trust_3_title', 'Authentic Goods', 'text', 'home', 'Trust 3 Title'),
  ('home_trust_3_sub', 'Handpicked quality', 'text', 'home', 'Trust 3 Subtitle'),
  ('home_trust_4_title', 'Easy Returns', 'text', 'home', 'Trust 4 Title'),
  ('home_trust_4_sub', 'Faulty items replaced', 'text', 'home', 'Trust 4 Subtitle'),
  ('about_story_extra', CONCAT('Today we serve customers nationwide, starting with accessories and growing into a multi-category general store — all backed by WhatsApp support from our team in Lahore.', CHAR(10), '', CHAR(10), 'Every order is personally handled. No bots. No long waits. Just real people who care about getting your order to you quickly and correctly.'), 'textarea', 'about', 'Story Extra Paragraphs'),
  ('about_cta_title', 'Ready to Shop With Us?', 'text', 'about', 'About CTA Title'),
  ('about_cta_sub', 'Join customers across Pakistan. Fast delivery. Real support.', 'text', 'about', 'About CTA Subtitle'),
  ('about_stat1_num', '500+', 'text', 'about', 'About Stat 1 Number'),
  ('about_stat1_label', 'Happy Customers', 'text', 'about', 'About Stat 1 Label'),
  ('about_stat2_num', '99%', 'text', 'about', 'About Stat 2 Number'),
  ('about_stat2_label', 'Satisfaction Rate', 'text', 'about', 'About Stat 2 Label'),
  ('about_stat3_num', '24/7', 'text', 'about', 'About Stat 3 Number'),
  ('about_stat3_label', 'Support Available', 'text', 'about', 'About Stat 3 Label'),
  ('about_stat4_num', '2+', 'text', 'about', 'About Stat 4 Number'),
  ('about_stat4_label', 'Years in Business', 'text', 'about', 'About Stat 4 Label'),
  ('about_stat5_num', '1000+', 'text', 'about', 'About Stat 5 Number'),
  ('about_stat5_label', 'Orders Fulfilled', 'text', 'about', 'About Stat 5 Label'),
  ('contact_title', 'Contact Us', 'text', 'contact', 'Contact Page Title'),
  ('contact_subtitle', 'Have a question or need help? We''re here for you — reach out anytime.', 'textarea', 'contact', 'Contact Page Subtitle'),
  ('faq_title', 'Frequently Asked Questions', 'text', 'faq', 'FAQ Page Title'),
  ('faq_subtitle', 'Find answers to the most common questions about our products and services.', 'textarea', 'faq', 'FAQ Page Subtitle'),
  ('faq_help_title', 'Still Need Help?', 'text', 'faq', 'FAQ Help Title'),
  ('faq_help_sub', 'Can''t find the answer you''re looking for? Our team is happy to help.', 'textarea', 'faq', 'FAQ Help Subtitle'),
  ('blog_title', 'S&Y Journal', 'text', 'blog', 'Blog Page Title'),
  ('blog_subtitle', 'Guides, tips and updates from our team.', 'textarea', 'blog', 'Blog Page Subtitle'),
  ('blog_newsletter_title', 'Stay in the Loop', 'text', 'blog', 'Blog Newsletter Title'),
  ('blog_newsletter_sub', 'Get the latest guides, tips and offers delivered to your inbox.', 'textarea', 'blog', 'Blog Newsletter Subtitle'),
  ('privacy_title', 'Privacy Policy', 'text', 'legal', 'Privacy Title'),
  ('privacy_updated', 'Last updated: 30 May 2026', 'text', 'legal', 'Privacy Last Updated'),
  ('privacy_content', '', 'textarea', 'legal', 'Privacy Policy Body'),
  ('terms_title', 'Terms & Conditions', 'text', 'legal', 'Terms Title'),
  ('terms_updated', 'Last updated: 30 May 2026', 'text', 'legal', 'Terms Last Updated'),
  ('terms_content', '', 'textarea', 'legal', 'Terms Body'),
  ('refund_title', 'Refund Policy', 'text', 'legal', 'Refund Title'),
  ('refund_updated', 'Last updated: 30 May 2026', 'text', 'legal', 'Refund Last Updated'),
  ('refund_content', '', 'textarea', 'legal', 'Refund Policy Body'),
  ('site_meta_description', 'S&Y — a Pakistani online store for accessories, gadgets and everyday products. Handpicked quality, authentic products, fast delivery across Pakistan.', 'textarea', 'settings', 'Default Meta Description'),
  ('site_keywords', 'S&Y, online store Pakistan, accessories Pakistan, gadgets, buy online Lahore, sandy.com.pk', 'textarea', 'settings', 'SEO Keywords'),
  ('whatsapp_btn_title', 'Chat on WhatsApp', 'text', 'settings', 'WhatsApp Button Title'),
  ('social_instagram', '', 'url', 'settings', 'Instagram URL'),
  ('social_facebook', '', 'url', 'settings', 'Facebook URL'),
  ('social_tiktok', '', 'url', 'settings', 'TikTok URL'),
  ('nav_home', 'Home', 'text', 'nav', 'Nav: Home'),
  ('nav_products', 'Products', 'text', 'nav', 'Nav: Products'),
  ('nav_track', 'Track Order', 'text', 'nav', 'Nav: Track Order'),
  ('nav_blog', 'Blog', 'text', 'nav', 'Nav: Blog'),
  ('nav_contact', 'Contact', 'text', 'nav', 'Nav: Contact'),
  ('nav_cart_label', 'Cart', 'text', 'nav', 'Nav: Cart Button'),
  ('nav_shop_label', 'Shop Now', 'text', 'nav', 'Nav: Shop Now Button'),
  ('footer_privacy', 'Privacy Policy', 'text', 'nav', 'Footer: Privacy'),
  ('footer_terms', 'Terms & Conditions', 'text', 'nav', 'Footer: Terms'),
  ('footer_refund', 'Refund Policy', 'text', 'nav', 'Footer: Refund'),
  ('footer_faq', 'FAQ', 'text', 'nav', 'Footer: FAQ'),
  ('home_view_all_label', 'View All Products →', 'text', 'home', 'View All Products Label'),
  ('home_view_all_link', '/products', 'text', 'home', 'View All Products Link'),
  ('home_search_placeholder', 'Search products...', 'text', 'home', 'Home Search Placeholder'),
  ('home_search_btn', 'Search', 'text', 'home', 'Home Search Button'),
  ('home_features_tag', 'Why Choose Us', 'text', 'home', 'Why Choose Us Tag'),
  ('home_newsletter_placeholder', 'your@email.com', 'text', 'home', 'Newsletter Placeholder'),
  ('home_newsletter_thanks', 'Thank you — we will be in touch.', 'text', 'home', 'Newsletter Thank You'),
  ('products_tag', 'The Collection', 'text', 'products', 'Products Page Tag'),
  ('products_title', 'All products', 'text', 'products', 'Products Page Title'),
  ('products_banner', 'Fast delivery across Pakistan. Need help? WhatsApp {phone}.', 'textarea', 'products', 'Products Banner'),
  ('products_empty', 'No products found.', 'text', 'products', 'Products Empty Text'),
  ('products_min', 'Min Rs.', 'text', 'products', 'Min Price Label'),
  ('products_max', 'Max Rs.', 'text', 'products', 'Max Price Label'),
  ('products_apply', 'Apply', 'text', 'products', 'Apply Filter Button'),
  ('pdp_back', '← Back to Products', 'text', 'shop', 'PDP Back Link'),
  ('pdp_pill_cod', 'Cash on Delivery', 'text', 'shop', 'PDP Pill: COD'),
  ('pdp_pill_delivery', 'Free delivery', 'text', 'shop', 'PDP Pill: Delivery'),
  ('pdp_pill_region', 'Pakistan-wide', 'text', 'shop', 'PDP Pill: Region'),
  ('pdp_help', 'We deliver across Pakistan. Need help? WhatsApp {phone}.', 'textarea', 'shop', 'PDP Help Note'),
  ('pdp_add', 'Add to cart', 'text', 'shop', 'Add to Cart Label'),
  ('pdp_added', 'Added to cart', 'text', 'shop', 'Added to Cart Label'),
  ('pdp_remove', 'Remove from cart', 'text', 'shop', 'Remove from Cart Label'),
  ('pdp_view_cart', 'View Cart & Checkout →', 'text', 'shop', 'View Cart Link Label'),
  ('pdp_about', 'About This Product', 'text', 'shop', 'About Section Heading'),
  ('pdp_included', 'What''s Included', 'text', 'shop', 'Included Section Heading'),
  ('cart_tag', 'Your Cart', 'text', 'cart', 'Cart Tag'),
  ('cart_title', 'My Cart', 'text', 'cart', 'Cart Title'),
  ('checkout_tag', 'Checkout', 'text', 'cart', 'Checkout Tag'),
  ('checkout_title', 'Complete Order', 'text', 'cart', 'Checkout Title'),
  ('cart_empty_title', 'Your cart is empty', 'text', 'cart', 'Empty Cart Title'),
  ('cart_empty_sub', 'Add some products to get started!', 'text', 'cart', 'Empty Cart Subtitle'),
  ('cart_empty_btn', 'Browse Products', 'text', 'cart', 'Empty Cart Button'),
  ('cart_empty_link', '/', 'text', 'cart', 'Empty Cart Button Link'),
  ('cart_summary', 'Order Summary', 'text', 'cart', 'Order Summary Heading'),
  ('cart_subtotal', 'Subtotal', 'text', 'cart', 'Subtotal Label'),
  ('cart_shipping', 'Shipping', 'text', 'cart', 'Shipping Label'),
  ('cart_shipping_free', 'Free', 'text', 'cart', 'Free Shipping Label'),
  ('cart_total', 'Total', 'text', 'cart', 'Total Label'),
  ('cart_checkout_btn', 'Proceed to Checkout →', 'text', 'cart', 'Checkout Button'),
  ('cart_place_btn', 'Place Order →', 'text', 'cart', 'Place Order Button'),
  ('cart_placing', 'Placing Order...', 'text', 'cart', 'Placing Order Label'),
  ('cart_details_heading', 'Your Details', 'text', 'cart', 'Details Heading'),
  ('cart_pay_heading', 'Payment Method', 'text', 'cart', 'Payment Heading'),
  ('cart_pay_cod_label', 'Cash on Delivery (COD)', 'text', 'cart', 'COD Label'),
  ('cart_pay_cod_sub', 'Pay in cash when your order arrives', 'text', 'cart', 'COD Subtitle'),
  ('cart_pay_jazz_label', 'JazzCash', 'text', 'cart', 'JazzCash Label'),
  ('cart_pay_jazz_sub', 'Pay via JazzCash and enter your payment reference', 'text', 'cart', 'JazzCash Subtitle'),
  ('cart_pay_easy_label', 'Easypaisa', 'text', 'cart', 'Easypaisa Label'),
  ('cart_pay_easy_sub', 'Pay via Easypaisa and enter your payment reference', 'text', 'cart', 'Easypaisa Subtitle'),
  ('cart_pay_bank_label', 'Bank Transfer', 'text', 'cart', 'Bank Transfer Label'),
  ('cart_pay_bank_sub', 'Transfer to our bank and upload your receipt', 'text', 'cart', 'Bank Transfer Subtitle'),
  ('cart_delivery_note', 'We deliver across Pakistan. You will receive order updates on WhatsApp.', 'textarea', 'cart', 'Delivery Note'),
  ('cart_prepaid_help', 'Account details will be shared after your order. Enter your payment reference below if you have already paid, or wait for our WhatsApp message with the account number.', 'textarea', 'cart', 'Prepaid Help Text'),
  ('order_success_title', 'Thank you for your order!', 'text', 'cart', 'Success Title'),
  ('order_success_sub', 'Your order has been received and is being processed.', 'textarea', 'cart', 'Success Subtitle'),
  ('order_success_wa', 'Need help? Chat with Support via WhatsApp (Optional)', 'text', 'cart', 'Success WhatsApp CTA'),
  ('order_success_wa_note', 'This is completely optional — your order is already confirmed and being processed above. Click only if you need immediate assistance.', 'textarea', 'cart', 'Success WhatsApp Note'),
  ('order_success_track', 'Track My Order →', 'text', 'cart', 'Success Track Button'),
  ('order_success_track_link', '/order-tracking', 'text', 'cart', 'Success Track Link'),
  ('tracking_tag', 'Order Tracking', 'text', 'tracking', 'Tracking Tag'),
  ('tracking_title', 'Track Your Order', 'text', 'tracking', 'Tracking Title'),
  ('tracking_sub', 'Enter your Order ID to check the latest status of your order.', 'textarea', 'tracking', 'Tracking Subtitle'),
  ('tracking_placeholder', 'e.g. FK44-62305', 'text', 'tracking', 'Tracking Placeholder'),
  ('tracking_btn', 'Track Order', 'text', 'tracking', 'Track Button'),
  ('tracking_help_title', 'Need Help?', 'text', 'tracking', 'Help Title'),
  ('tracking_help_sub', 'Can''t find your order or have a question? Chat with us on WhatsApp.', 'textarea', 'tracking', 'Help Subtitle'),
  ('tracking_help_btn', 'WhatsApp Us', 'text', 'tracking', 'Help Button'),
  ('about_hero_tag', 'Our Story', 'text', 'about', 'About Hero Tag'),
  ('about_story_tag', 'Who We Are', 'text', 'about', 'Story Tag'),
  ('about_story_heading', 'Built on Trust', 'text', 'about', 'Story Heading'),
  ('about_values_tag', 'What We Stand For', 'text', 'about', 'Values Tag'),
  ('about_journey_tag', 'Our Journey', 'text', 'about', 'Journey Tag'),
  ('about_journey_title', 'How We Grew', 'text', 'about', 'Journey Title'),
  ('about_cta_btn1_text', 'Browse Products', 'text', 'about', 'CTA Button 1 Text'),
  ('about_cta_btn1_link', '/products', 'text', 'about', 'CTA Button 1 Link'),
  ('about_cta_btn2_text', 'Get In Touch', 'text', 'about', 'CTA Button 2 Text'),
  ('about_cta_btn2_link', '/contact', 'text', 'about', 'CTA Button 2 Link'),
  ('about_point1_icon', '🇵🇰', 'text', 'about', 'Point 1 Icon'),
  ('about_point1_title', 'Pakistan Based', 'text', 'about', 'Point 1 Title'),
  ('about_point1_desc', 'We operate from Lahore and deliver across Pakistan.', 'textarea', 'about', 'Point 1 Description'),
  ('about_point2_icon', '🤝', 'text', 'about', 'Point 2 Icon'),
  ('about_point2_title', 'Personal Service', 'text', 'about', 'Point 2 Title'),
  ('about_point2_desc', 'Every customer gets direct WhatsApp support from our team.', 'textarea', 'about', 'Point 2 Description'),
  ('about_point3_icon', '⚡', 'text', 'about', 'Point 3 Icon'),
  ('about_point3_title', 'Fast & Reliable', 'text', 'about', 'Point 3 Title'),
  ('about_point3_desc', 'Orders processed quickly after confirmation.', 'textarea', 'about', 'Point 3 Description'),
  ('about_point4_icon', '💰', 'text', 'about', 'Point 4 Icon'),
  ('about_point4_title', 'Fair Pricing', 'text', 'about', 'Point 4 Title'),
  ('about_point4_desc', 'No hidden fees. What you see is what you pay.', 'textarea', 'about', 'Point 4 Description'),
  ('about_tl1_year', '2026', 'text', 'about', 'Timeline 1 Year'),
  ('about_tl1_icon', '🚀', 'text', 'about', 'Timeline 1 Icon'),
  ('about_tl1_title', 'S&Y launches', 'text', 'about', 'Timeline 1 Title'),
  ('about_tl1_desc', 'S&Y opened as a Pakistani online store, starting with accessories and nationwide delivery.', 'textarea', 'about', 'Timeline 1 Description'),
  ('about_tl2_year', '2026', 'text', 'about', 'Timeline 2 Year'),
  ('about_tl2_icon', '📦', 'text', 'about', 'Timeline 2 Icon'),
  ('about_tl2_title', 'Growing catalogue', 'text', 'about', 'Timeline 2 Title'),
  ('about_tl2_desc', 'We are expanding into more categories so you can shop everyday essentials in one place.', 'textarea', 'about', 'Timeline 2 Description'),
  ('about_tl3_year', '2026', 'text', 'about', 'Timeline 3 Year'),
  ('about_tl3_icon', '💬', 'text', 'about', 'Timeline 3 Icon'),
  ('about_tl3_title', 'WhatsApp support', 'text', 'about', 'Timeline 3 Title'),
  ('about_tl3_desc', 'Direct WhatsApp support from our Lahore team — real people, fast replies.', 'textarea', 'about', 'Timeline 3 Description'),
  ('about_tl4_year', '2026', 'text', 'about', 'Timeline 4 Year'),
  ('about_tl4_icon', '🌟', 'text', 'about', 'Timeline 4 Icon'),
  ('about_tl4_title', 'Nationwide delivery', 'text', 'about', 'Timeline 4 Title'),
  ('about_tl4_desc', 'Cash on Delivery, JazzCash, Easypaisa and bank transfer across Pakistan.', 'textarea', 'about', 'Timeline 4 Description'),
  ('about_tl5_year', '2026', 'text', 'about', 'Timeline 5 Year'),
  ('about_tl5_icon', '🛍️', 'text', 'about', 'Timeline 5 Icon'),
  ('about_tl5_title', 'New website', 'text', 'about', 'Timeline 5 Title'),
  ('about_tl5_desc', 'Launched our custom-built website with order tracking and easy checkout.', 'textarea', 'about', 'Timeline 5 Description'),
  ('contact_tag', 'Get In Touch', 'text', 'contact', 'Contact Tag'),
  ('contact_wa_title', 'WhatsApp', 'text', 'contact', 'WhatsApp Card Title'),
  ('contact_wa_sub', 'Fastest response', 'text', 'contact', 'WhatsApp Card Subtitle'),
  ('contact_tg_title', 'Telegram', 'text', 'contact', 'Telegram Card Title'),
  ('contact_tg_sub', 'Message us anytime', 'text', 'contact', 'Telegram Card Subtitle'),
  ('contact_email_title', 'Email', 'text', 'contact', 'Email Card Title'),
  ('contact_email_sub', 'Reply within 24 hours', 'text', 'contact', 'Email Card Subtitle'),
  ('contact_hours_title', 'Support Hours', 'text', 'contact', 'Hours Card Title'),
  ('contact_hours_sub', '7 days a week', 'text', 'contact', 'Hours Card Subtitle'),
  ('contact_address_title', 'Based In', 'text', 'contact', 'Address Card Title'),
  ('contact_address_sub', 'Nationwide delivery', 'text', 'contact', 'Address Card Subtitle'),
  ('contact_form_title', 'Send Us a Message', 'text', 'contact', 'Form Title'),
  ('contact_success_title', 'Message Sent!', 'text', 'contact', 'Success Title'),
  ('contact_success_sub', 'Thank you for reaching out. We''ll get back to you within 24 hours. For urgent queries, please WhatsApp us directly.', 'textarea', 'contact', 'Success Subtitle'),
  ('faq_tag', 'Help Centre', 'text', 'faq', 'FAQ Tag'),
  ('faq_btn_whatsapp', 'WhatsApp Us', 'text', 'faq', 'FAQ WhatsApp Button'),
  ('faq_btn_telegram', 'Telegram', 'text', 'faq', 'FAQ Telegram Button'),
  ('faq_btn_contact', 'Contact Form', 'text', 'faq', 'FAQ Contact Button'),
  ('blog_tag', 'Our Blog', 'text', 'blog', 'Blog Tag'),
  ('blog_read_more', 'Read →', 'text', 'blog', 'Read More Label'),
  ('blog_featured_label', 'Featured', 'text', 'blog', 'Featured Label'),
  ('blog_newsletter_btn', 'Subscribe', 'text', 'blog', 'Newsletter Button'),
  ('blog_newsletter_placeholder', 'your@email.com', 'text', 'blog', 'Newsletter Placeholder'),
  ('blog_newsletter_thanks', 'You''re subscribed! Thank you.', 'text', 'blog', 'Newsletter Thank You'),
  ('blog_post_cta_title', 'Ready to Shop?', 'text', 'blog', 'Post CTA Title'),
  ('blog_post_cta_sub', 'Browse accessories, gadgets and everyday products delivered across Pakistan.', 'textarea', 'blog', 'Post CTA Subtitle'),
  ('blog_post_cta_btn', 'View Products →', 'text', 'blog', 'Post CTA Button'),
  ('blog_post_cta_link', '/products', 'text', 'blog', 'Post CTA Link'),
  ('blog_post_faq_title', 'Frequently Asked Questions', 'text', 'blog', 'Post FAQ Heading'),
  ('legal_tag', 'Legal', 'text', 'legal', 'Legal Tag'),
  ('refund_sum1_title', 'Physical Products', 'text', 'legal', 'Refund Card 1 Title'),
  ('refund_sum1_text', '14-day return window from delivery date', 'textarea', 'legal', 'Refund Card 1 Text'),
  ('refund_sum2_title', 'Prepaid Orders', 'text', 'legal', 'Refund Card 2 Title'),
  ('refund_sum2_text', 'Refunds after we confirm the return', 'textarea', 'legal', 'Refund Card 2 Text'),
  ('refund_sum3_title', 'Faulty Items', 'text', 'legal', 'Refund Card 3 Title'),
  ('refund_sum3_text', 'Full refund or replacement at no cost', 'textarea', 'legal', 'Refund Card 3 Text'),
  ('refund_sum4_title', 'Return Postage', 'text', 'legal', 'Refund Card 4 Title'),
  ('refund_sum4_text', 'Customer''s responsibility unless item is faulty', 'textarea', 'legal', 'Refund Card 4 Text'),
  ('refund_cta_title', 'Need Help With a Return?', 'text', 'legal', 'Refund CTA Title'),
  ('refund_cta_sub', 'Our team is here to help. Contact us via WhatsApp for the fastest response.', 'textarea', 'legal', 'Refund CTA Subtitle'),
  ('refund_cta_btn', 'WhatsApp Us', 'text', 'legal', 'Refund CTA Button');

-- ========== site_content: default home/about sections (json) ==========
INSERT IGNORE INTO site_content (content_key, content_value, content_type, page_name, label, section_order, is_visible) VALUES
  ('home_hero', '{"title":"Quality products, delivered across Pakistan","subtitle":"S&Y is your Pakistani online store for accessories, gadgets and everyday essentials.","button_text":"Shop Now","button_link":"/products","secondary_button_text":"Learn More","secondary_button_link":"/about"}', 'json', 'home', 'Hero Section', 1, 1),
  ('home_featured_products', '{"title":"Our Products","subtitle":"Handpicked quality for every need","show_count":6}', 'json', 'home', 'Featured Products Section', 2, 1),
  ('home_features', '{"title":"Why Choose Us","items":[{"icon":"⚡","title":"Quality","description":"Handpicked products"},{"icon":"🔒","title":"Authentic","description":"Genuine items"},{"icon":"💬","title":"Support","description":"WhatsApp help"},{"icon":"🚀","title":"Fast Delivery","description":"Across Pakistan"}]}', 'json', 'home', 'Features Section', 3, 1),
  ('home_testimonials', '{"title":"What Our Customers Say","items":[{"name":"Ahmed Khan","rating":5,"text":"Fast delivery to Lahore and the product was exactly as described."},{"name":"Sara Ali","rating":5,"text":"Easy checkout with COD. Will order again."}]}', 'json', 'home', 'Testimonials Section', 4, 1),
  ('home_newsletter', '{"title":"Stay in the Loop","subtitle":"Get the latest products, tips and offers delivered to your inbox","button_text":"Subscribe"}', 'json', 'home', 'Newsletter Section', 5, 1),
  ('about_hero', '{"title":"About S&Y","subtitle":"Your Pakistani online store for accessories, gadgets and everyday products"}', 'json', 'about', 'Hero Section', 1, 1),
  ('about_mission', '{"title":"Our Mission","text":"We bring quality products to customers across Pakistan — honest prices, authentic items, and delivery you can rely on."}', 'json', 'about', 'Mission Section', 2, 1),
  ('about_values', '{"title":"Our Values","items":[{"icon":"🎯","title":"Quality","description":"Best in class products every time"},{"icon":"❤️","title":"Trust","description":"Transparent & honest always"},{"icon":"🚀","title":"Speed","description":"Fast delivery nationwide"}]}', 'json', 'about', 'Values Section', 3, 1);

-- ========== faqs: starter set, ONLY when the faqs table is empty ==========
INSERT INTO faqs (question, answer, category, sort_order)
SELECT seed.question, seed.answer, seed.category, seed.sort_order
FROM (
  SELECT 1 AS seq, 'How do I place an order?' AS question, 'Browse our products, add items to your cart, fill in your delivery details, choose your payment method (Cash on Delivery, JazzCash, Easypaisa or bank transfer), and click Place Order. You''ll receive an Order ID instantly.' AS answer, 'Orders & Payment' AS category, 1 AS sort_order
  UNION ALL SELECT 2, 'What payment methods do you accept?', 'We accept Cash on Delivery, JazzCash, Easypaisa and bank transfer. Account details for prepaid methods are shared after you place the order. You can upload a payment receipt at checkout.', 'Orders & Payment', 2
  UNION ALL SELECT 3, 'How do I pay by JazzCash, Easypaisa or bank transfer?', 'Select the method at checkout, place your order, then wait for our WhatsApp message with account details. Transfer the exact amount, enter your payment reference, and optionally upload a screenshot of the receipt.', 'Orders & Payment', 3
  UNION ALL SELECT 4, 'Is cash on delivery available?', 'Yes. Cash on delivery is available across Pakistan. Select COD at checkout and pay when your order arrives.', 'Orders & Payment', 4
  UNION ALL SELECT 5, 'Can I cancel my order?', 'You can cancel your order before it has been dispatched. Please contact us via WhatsApp (+923334800181) with your Order ID as soon as possible. Once dispatched, cancellations are not possible but you may be eligible for a return.', 'Orders & Payment', 5
  UNION ALL SELECT 6, 'How long does delivery take?', 'We deliver across Pakistan. Most orders arrive within 2–5 working days depending on your city.', 'Delivery & Shipping', 1
  UNION ALL SELECT 7, 'Do you deliver across Pakistan?', 'Yes, we deliver nationwide including Punjab, Sindh, KPK, Balochistan, Islamabad, Gilgit-Baltistan and AJK.', 'Delivery & Shipping', 2
  UNION ALL SELECT 8, 'How much does shipping cost?', 'Shipping is currently free on all orders.', 'Delivery & Shipping', 3
  UNION ALL SELECT 9, 'How do I track my order?', 'Once your order is confirmed, use your Order ID on our Order Tracking page to check real-time status — from confirmation through to delivery.', 'Delivery & Shipping', 4
  UNION ALL SELECT 10, 'Are your products authentic?', 'Yes. We source carefully and stand behind every item we sell. If something is not as described, contact us on WhatsApp and we will make it right.', 'Products & Setup', 1
  UNION ALL SELECT 11, 'Do you sell accessories and gadgets?', 'Yes. S&Y is a Pakistani general store. We are launching with accessories first and will add more categories over time.', 'Products & Setup', 2
  UNION ALL SELECT 12, 'What if I received a faulty item?', 'Please contact us immediately via WhatsApp (+923334800181) with photos of the fault. We''ll arrange a replacement or refund.', 'Returns & Refunds', 3
  UNION ALL SELECT 13, 'How do I return an item?', 'Contact us via WhatsApp (+923334800181) or email with your Order ID and reason for return. We''ll guide you through the process.', 'Returns & Refunds', 2
  UNION ALL SELECT 14, 'What is your refund policy?', 'Please see our Refund Policy page for full details. Faulty items are replaced or refunded. Unused items in original condition may be returned as described in the policy.', 'Returns & Refunds', 1
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM faqs)
ORDER BY seed.seq;

-- ========== faqs: required FAQs, each only when no FAQ with the same question exists ==========
INSERT INTO faqs (question, answer, category, sort_order)
SELECT 'Do you offer Cash on Delivery?', 'Yes. COD is available across Pakistan and is selected by default at checkout.', 'Orders & Payment', 6 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE question = 'Do you offer Cash on Delivery?');

INSERT INTO faqs (question, answer, category, sort_order)
SELECT 'How do I contact support?', 'WhatsApp us on +923334800181 or email info@sandy.com.pk. We typically reply during business hours.', 'General', 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE question = 'How do I contact support?');

INSERT INTO faqs (question, answer, category, sort_order)
SELECT 'Where are you based?', 'S&Y is based in Lahore, Pakistan, and delivers nationwide.', 'General', 2 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM faqs WHERE question = 'Where are you based?');

-- ========== POST-CHECK ==========
SELECT
  (SELECT COUNT(*) FROM site_content) AS site_content_rows,
  (SELECT COUNT(*) FROM site_content WHERE content_type = 'json') AS section_rows,
  (SELECT COUNT(*) FROM faqs) AS faq_rows;
