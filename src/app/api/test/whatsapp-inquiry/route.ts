import { NextRequest, NextResponse } from "next/server";
import { sendGuestReplyApprovalTemplate } from "@/lib/whatsapp";
import { draftEscalationAnswerForApproval } from "@/lib/chatWidget";
import { createChatEscalation, linkChatEscalationWamid } from "@/lib/chatEscalations";

/**
 * TEST ENDPOINT — simulates a guest inquiry WITHOUT needing another WhatsApp number.
 * This directly triggers the approval workflow, bypassing the webhook.
 * POST with optional JSON body: { guestName?, visitorPhone?, question? }
 * Defaults to a sample inquiry and sends the approval alert to Seni.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    const visitorName = body.guestName || "Test Guest (Simulated)";
    const visitorPhone = body.visitorPhone || "15551234567"; // fake guest number
    const question = body.question || "Do you have any properties available in October?";

    console.log(`[test-inquiry] Simulating guest inquiry from ${visitorName} (${visitorPhone})`);

    // Draft an AI-suggested answer
    let aiDraftAnswer: string | undefined;
    try {
      aiDraftAnswer = await draftEscalationAnswerForApproval(question);
      console.log(`[test-inquiry] AI draft: "${aiDraftAnswer}"`);
    } catch (err) {
      console.error("[test-inquiry] AI draft failed:", err);
      aiDraftAnswer = "We'd love to help! Please let us know your preferred dates and we'll check availability.";
    }

    // Create the escalation record (same as real inquiry flow)
    const escalation = await createChatEscalation({
      question,
      visitorName,
      visitorPhone,
      aiDraftAnswer,
      source: "test_endpoint",
    });
    console.log(`[test-inquiry] Created escalation: ${escalation.id}`);

    // Send the approval template to Seni
    let approvalWamid: string | undefined;
    try {
      approvalWamid = await sendGuestReplyApprovalTemplate({
        guestName: visitorName,
        propertyName: "Legacy Colombia",
        guestMessage: question,
        suggestedReply: aiDraftAnswer ?? "N/A",
      });
      console.log(`[test-inquiry] ✅ Approval template sent (wamid: ${approvalWamid})`);
    } catch (err) {
      console.error("[test-inquiry] ❌ Failed to send approval template:", err);
      return NextResponse.json(
        { error: `Template send failed: ${err instanceof Error ? err.message : "Unknown error"}` },
        { status: 500 }
      );
    }

    if (approvalWamid) {
      await linkChatEscalationWamid(escalation.id, approvalWamid);
    }

    return NextResponse.json({
      ok: true,
      escalationId: escalation.id,
      visitorName,
      visitorPhone,
      question,
      suggestedReply: aiDraftAnswer,
      approvalWamid,
      message: "✅ Guest inquiry SIMULATED - approval alert should arrive on your WhatsApp NOW with YES/NO/EDIT options",
    });
  } catch (err) {
    console.error("[test-inquiry] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return NextResponse.json({
    message: "Test endpoint for guest inquiry simulation",
    usage: 'POST with optional JSON: { guestName, visitorPhone, question }',
    example: {
      method: "POST",
      body: { question: "Do you have availability?" },
    },
  });
}
