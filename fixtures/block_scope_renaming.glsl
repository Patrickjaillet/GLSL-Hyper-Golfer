void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float x = 0.0;

    // Two disjoint if/else locals with different original names --
    // never coexist, so they can share a short name.
    if (x > 0.5)
    {
        float tempResult = x * 2.0;
        x = tempResult;
    }
    else
    {
        float otherThing = x + 1.0;
        x = otherThing;
    }

    // Same loop-counter spelling reused across two disjoint for loops.
    float total = 0.0;
    for (int i = 0; i < 3; i++)
    {
        total += float(i);
    }
    for (int i = 0; i < 5; i++)
    {
        total += float(i) * 2.0;
    }

    // A genuine ancestor/descendant chain -- must never reuse a name.
    float outer = 1.0;
    if (outer > 0.0)
    {
        float mid = 2.0;
        if (mid > 0.0)
        {
            float inner = 3.0;
            outer = inner;
        }
    }

    fragColor = vec4(x + total + outer);
}
