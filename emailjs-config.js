/* =========================================================
   arvcoin — EmailJS config (FREE email OTP)
   ---------------------------------------------------------
   EmailJS = free service jo email bhejta hai bina backend ke.
   Free plan: 200 emails/month.

   SETUP (ek baar):
   1) Sign up free at https://www.emailjs.com
   2) "Email Services" -> Add Service (Gmail connect karo) -> SERVICE ID milega
   3) "Email Templates" -> Create -> put {{passcode}} in the body,
      and {{email}} in the "To Email" field -> you get a TEMPLATE ID
   4) "Account" -> API Keys -> PUBLIC KEY copy karo
   5) Neeche teeno values paste karo (PASTE_... hata ke)

   Until the values are filled in, OTP runs in DEMO mode
   (the code shows in an alert and the console, for testing).
   ========================================================= */
window.ARV_EMAILJS = {
  publicKey:  "1qyrt9cTAhqjwA8gE",
  serviceId:  "service_joko2ab",
  templateId: "template_7jhk5jp"
};
