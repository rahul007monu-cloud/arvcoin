/* =========================================================
   arvcoin — EmailJS config (FREE email OTP)
   ---------------------------------------------------------
   EmailJS = free service jo email bhejta hai bina backend ke.
   Free plan: 200 emails/month.

   SETUP (ek baar):
   1) https://www.emailjs.com  pe free signup karo
   2) "Email Services" -> Add Service (Gmail connect karo) -> SERVICE ID milega
   3) "Email Templates" -> Create -> body me {{passcode}} likho,
      "To Email" field me {{email}} daalo -> TEMPLATE ID milega
   4) "Account" -> API Keys -> PUBLIC KEY copy karo
   5) Neeche teeno values paste karo (PASTE_... hata ke)

   Jab tak values nahi daali, OTP DEMO mode me chalega
   (code alert/console me dikhega — testing ke liye).
   ========================================================= */
window.ARV_EMAILJS = {
  publicKey:  "1qyrt9cTAhqjwA8gE",
  serviceId:  "service_joko2ab",
  templateId: "template_7jhk5jp"
};
