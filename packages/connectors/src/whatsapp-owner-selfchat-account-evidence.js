// Used inside a reviewed authenticated bridge. Never accepts a caller-selected
// account/contact. The SDK may use cached WhatsApp mappings; this is not proof
// of a fresh server query or of a human interacting with the phone.
export async function collectOwnerSelfChatAccountEvidence({client,chatId,challenge,
  policy,isReady,now=Date.now}) {
  const fail=()=>{throw new Error('selfchat_account_evidence_unavailable');};
  if(!/^[a-f0-9]{32}$/.test(challenge || '') || !/^\d+@c\.us$/.test(chatId || '')
      || typeof client?.getContactLidAndPhone!=='function')fail();
  const check=()=>{if(isReady()!==true || client?.info?.wid?._serialized!==chatId)fail();};
  try {
    check();
    const forward=await client.getContactLidAndPhone([chatId]);
    check();
    if(!Array.isArray(forward) || forward.length!==1 || forward[0]?.pn!==chatId
        || !/^\d+@lid$/.test(forward[0]?.lid || ''))fail();
    const lid=forward[0].lid;
    // PN-input lookup echoes PN, so separately require the SDK's reverse map.
    const reverse=await client.getContactLidAndPhone([lid]);
    check();
    if(!Array.isArray(reverse) || reverse.length!==1 || reverse[0]?.pn!==chatId
        || reverse[0]?.lid!==lid)fail();
    return {ok:true,version:1,challenge,checkedAt:new Date(now()).toISOString(),
      authenticated:true,ready:true,state:'ready',ownChatId:chatId,ownLid:lid,
      mappingSource:'whatsapp-sdk-bidirectional',serverRefreshVerified:false,
      ownerSelfChatPolicy:policy};
  } catch { fail(); }
}
